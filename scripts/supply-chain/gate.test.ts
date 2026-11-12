import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_SCOPES,
  evaluateAudit,
  evaluateAuditScopes,
  parseAllowlist,
  parseAuditReport,
  type Advisory,
  type AllowlistEntry,
} from './audit.ts';
import { evaluateBuilds, parseIgnoredBuilds, readBuildConfig } from './builds.ts';

const advisory = (ghsa: string, module: string, severity: string) => ({
  github_advisory_id: ghsa,
  module_name: module,
  severity,
  title: `${module} issue`,
  url: `https://github.com/advisories/${ghsa}`,
  findings: [{ version: '1.0.0', paths: [`apps__core>${module}`] }],
});

const report = (advisories: ReturnType<typeof advisory>[], high = 0, critical = 0) =>
  JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(advisories.map((item, index) => [String(index + 1), item])),
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical } },
  });

const HIGH = 'GHSA-gpj5-g38j-94v9';
const LOW = 'GHSA-389g-gv7q-r4x8';
const CRITICAL = 'GHSA-wf5p-g6vw-rhxx';

describe('pnpm audit gate', () => {
  const advisories: Advisory[] = parseAuditReport(
    report([advisory(HIGH, 'drizzle-orm', 'high'), advisory(LOW, 'fastify', 'low')], 1),
  );
  const entry = (overrides: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
    id: HIGH,
    package: 'drizzle-orm',
    reason: 'Identifiers never come from user input',
    expires: '2026-12-31',
    ...overrides,
  });

  it('blocks a high advisory that is not allowlisted, and ignores low ones', () => {
    const verdict = evaluateAudit(advisories, [], '2026-11-12');
    expect(verdict.blocking.map((item) => item.ghsa)).toEqual([HIGH]);
    expect(verdict.blocking[0]?.paths).toEqual(['apps__core>drizzle-orm']);
  });

  it('allows an advisory with an unexpired entry for the same package, through its expiry day', () => {
    expect(evaluateAudit(advisories, [entry()], '2026-12-31')).toMatchObject({ blocking: [], expired: [] });
    expect(evaluateAudit(advisories, [entry()], '2026-12-31').allowed).toHaveLength(1);
  });

  it('fails on an expired entry and blocks what it covered', () => {
    const verdict = evaluateAudit(advisories, [entry({ expires: '2026-11-11' })], '2026-11-12');
    expect(verdict.expired).toHaveLength(1);
    expect(verdict.blocking.map((item) => item.ghsa)).toEqual([HIGH]);
  });

  it('does not let an entry for another package cover the advisory', () => {
    const verdict = evaluateAudit(advisories, [entry({ package: 'fastify' })], '2026-11-12');
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.unused).toHaveLength(1);
  });

  it('fails closed on a registry error or an incomplete report', () => {
    expect(() => parseAuditReport(JSON.stringify({ error: { code: 'ENOTFOUND' } }))).toThrow(
      /pnpm audit failed/,
    );
    expect(() => parseAuditReport(JSON.stringify({ advisories: {} }))).toThrow(/metadata/);
    expect(() => parseAuditReport('not json')).toThrow();
    expect(() => parseAuditReport(report([], 2))).toThrow(/lists no such advisory/);
  });

  it('rejects malformed allowlist entries', () => {
    const file = (item: object) => JSON.stringify({ advisories: [item] });
    expect(() => parseAllowlist(file({ ...entry(), id: 'CVE-2026-1' }))).toThrow(/not a GHSA id/);
    expect(() => parseAllowlist(file({ ...entry(), reason: ' ' }))).toThrow(/reason/);
    expect(() => parseAllowlist(file({ ...entry(), expires: 'next year' }))).toThrow(/YYYY-MM-DD/);
    expect(() => parseAllowlist(JSON.stringify({ advisories: [entry(), entry()] }))).toThrow(/twice/);
    expect(parseAllowlist(file(entry()))).toEqual([entry()]);
  });

  describe('dev dependencies', () => {
    const [production, dev] = AUDIT_SCOPES;
    if (!production || !dev) throw new Error('expected a production and a dev scope');
    const devAdvisories = parseAuditReport(
      report([advisory(HIGH, 'vite', 'high'), advisory(CRITICAL, 'esbuild', 'critical')], 1, 1),
      dev.severities,
    );
    const scoped = (allowlist: AllowlistEntry[], today = '2026-11-12') =>
      evaluateAuditScopes(
        [
          { scope: production, advisories },
          { scope: dev, advisories: devAdvisories },
        ],
        allowlist,
        today,
      );

    it('audits production at high and dev at critical severity', () => {
      expect(AUDIT_SCOPES.map((scope) => [scope.flag, [...scope.severities]])).toEqual([
        ['--prod', ['high', 'critical']],
        ['--dev', ['critical']],
      ]);
      const verdict = scoped([]);
      expect(verdict.blocking.map((item) => [item.scope, item.module, item.severity])).toEqual([
        ['production', 'drizzle-orm', 'high'],
        ['dev', 'esbuild', 'critical'],
      ]);
    });

    it('lets the same allowlist cover a dev advisory, and calls an entry unused only if no scope matches', () => {
      const allowlist = [
        entry(),
        entry({ id: CRITICAL, package: 'esbuild', reason: 'Only bundles our own code' }),
        entry({ id: LOW, package: 'nothing-here' }),
      ];
      const verdict = scoped(allowlist);
      expect(verdict.blocking).toEqual([]);
      expect(verdict.allowed.map((item) => [item.scope, item.ghsa])).toEqual([
        ['production', HIGH],
        ['dev', CRITICAL],
      ]);
      expect(verdict.unused.map((item) => item.package)).toEqual(['nothing-here']);
      // An expired entry is reported once and blocks what it covered.
      const expired = scoped([entry({ id: CRITICAL, package: 'esbuild', expires: '2026-11-11' })]);
      expect(expired.expired).toHaveLength(1);
      expect(expired.blocking.map((item) => item.ghsa)).toEqual([HIGH, CRITICAL]);
    });

    it('fails closed when a dev report counts critical findings it does not list', () => {
      expect(() => parseAuditReport(report([], 0, 1), dev.severities)).toThrow(/critical findings/);
      expect(() => parseAuditReport(report([], 3, 0), dev.severities)).not.toThrow();
    });
  });

  it('accepts the checked-in allowlist', () => {
    const raw = readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8');
    expect(() => parseAllowlist(raw)).not.toThrow();
  });
});

describe('build-script gate', () => {
  const manifest = (pnpm: object) => JSON.stringify({ name: 'x', pnpm });
  const allowed = ['better-sqlite3', 'esbuild', 'node-pty'];
  const ignored = ['cpu-features', 'ssh2'];

  it('accepts the checked-in package.json and pnpm-workspace.yaml', () => {
    const root = new URL('../../', import.meta.url);
    const config = readBuildConfig(readFileSync(new URL('package.json', root), 'utf8'));
    const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8');
    expect(config.onlyBuiltDependencies.toSorted()).toEqual(allowed);
    expect(workspace).toMatch(/^strictDepBuilds: true$/m);
    expect(evaluateBuilds(config, [], [{ path: 'pnpm-workspace.yaml', text: workspace }])).toEqual([]);
  });

  it('flags a new entry in onlyBuiltDependencies or ignoredBuiltDependencies', () => {
    const config = readBuildConfig(
      manifest({
        onlyBuiltDependencies: [...allowed, 'cpu-features'],
        ignoredBuiltDependencies: ['ssh2', 'core-js'],
      }),
    );
    const problems = evaluateBuilds(config, [], []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/onlyBuiltDependencies adds "cpu-features"/);
    expect(problems[1]).toMatch(/ignoredBuiltDependencies adds "core-js"/);
  });

  it('flags packages pnpm ignored without a review', () => {
    const output = [
      'Automatically ignored builds during installation:',
      '  cpu-features',
      '  ssh2',
      'hint: To allow the execution of build scripts ...',
    ].join('\n');
    const unreviewed = parseIgnoredBuilds(output);
    expect(unreviewed).toEqual(ignored);
    const config = readBuildConfig(manifest({ onlyBuiltDependencies: allowed }));
    expect(evaluateBuilds(config, unreviewed, [])).toEqual([
      '"cpu-features" has an install script that is neither allowed nor reviewed',
      '"ssh2" has an install script that is neither allowed nor reviewed',
    ]);
  });

  it('reads "None" as no unreviewed builds and fails closed on unknown output', () => {
    expect(
      parseIgnoredBuilds('Automatically ignored builds during installation:\n  None\n\nExplicitly ...'),
    ).toEqual([]);
    expect(() => parseIgnoredBuilds('something else')).toThrow(/unrecognised/);
  });

  it('flags settings elsewhere that would let more packages build', () => {
    const config = readBuildConfig(manifest({ onlyBuiltDependencies: allowed }));
    expect(
      evaluateBuilds(config, [], [{ path: '.npmrc', text: 'dangerously-allow-all-builds=true\n' }]),
    ).toHaveLength(1);
    expect(
      evaluateBuilds(
        config,
        [],
        [{ path: 'pnpm-workspace.yaml', text: 'onlyBuiltDependencies:\n  - core-js\n' }],
      ),
    ).toHaveLength(1);
    expect(
      evaluateBuilds(config, [], [{ path: 'pnpm-workspace.yaml', text: 'strictDepBuilds: false\n' }]),
    ).toHaveLength(1);
    // The .npmrc list form, other spellings and quoted keys.
    for (const [path, text] of [
      ['.npmrc', 'only-built-dependencies[]=core-js\n'],
      ['.npmrc', 'only-built-dependencies[] = core-js\n'],
      ['.npmrc', 'only_built_dependencies[]=core-js\n'],
      ['.npmrc', 'never-built-dependencies[]=esbuild\n'],
      ['.npmrc', 'dangerously_allow_all_builds=true\n'],
      ['.npmrc', 'strict-dep-builds=false\n'],
      ['pnpm-workspace.yaml', "'onlyBuiltDependencies': [core-js]\n"],
      ['pnpm-workspace.yaml', '"dangerouslyAllowAllBuilds": true\n'],
      ['pnpm-workspace.yaml', "strictDepBuilds: 'false'\n"],
    ] as const) {
      expect(evaluateBuilds(config, [], [{ path, text }]), text).toHaveLength(1);
    }
    expect(
      evaluateBuilds(
        config,
        [],
        [{ path: '.npmrc', text: 'strict-dep-builds=true\nauto-install-peers=true\n' }],
      ),
    ).toEqual([]);
    expect(() => readBuildConfig(manifest({ neverBuiltDependencies: [] }))).toThrow(
      /onlyBuiltDependencies only/,
    );
    expect(() => readBuildConfig(manifest({ onlyBuiltDependencies: 'esbuild' }))).toThrow(/array/);
  });
});
