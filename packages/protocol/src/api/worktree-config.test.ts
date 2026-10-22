import { describe, expect, it } from 'vitest';
import { MAX_WORKTREE_YML_BYTES } from './projects.js';
import {
  COMPOSE_FILE_NAMES,
  ContainerPreviewChoice,
  isEmberlineDirPath,
  isWorktreeYmlPath,
  SaveWorktreeConfigBody,
  UseContainerPreviewBody,
  ValidateWorktreeConfigBody,
  WorktreeConfig,
  WORKTREE_CONFIG_LIMITS,
} from './worktree-config.js';

const SPEC_EXAMPLE = {
  version: 1,
  copy: ['.env', { path: '.env.local', mode: 'symlink' }],
  setup: ['pnpm install --frozen-lockfile'],
  teardown: ['docker compose down'],
  services: [{ name: 'web', command: 'pnpm dev --port $PORT --host 0.0.0.0', preview: true }],
  checks: { build: 'pnpm build', lint: 'pnpm lint', test: 'pnpm test' },
};

const bad = (patch: Record<string, unknown>) => WorktreeConfig.safeParse({ version: 1, ...patch });

describe('WorktreeConfig v1', () => {
  it('accepts the spec example and defaults copy mode', () => {
    const out = WorktreeConfig.parse(SPEC_EXAMPLE);
    expect(out.services[0]?.preview).toBe(true);
    expect(out.checks.build).toBe('pnpm build');
  });
  it('accepts a minimal file', () => {
    const out = WorktreeConfig.parse({ version: 1 });
    expect(out).toMatchObject({ copy: [], setup: [], teardown: [], services: [], checks: {} });
  });
  it('requires version 1 or 2', () => {
    expect(WorktreeConfig.safeParse({}).success).toBe(false);
    expect(WorktreeConfig.safeParse({ version: 2 }).success).toBe(true);
  });
  it('rejects unknown keys', () => {
    expect(bad({ extra: 1 }).success).toBe(false);
    expect(bad({ checks: { deploy: 'x' } }).success).toBe(false);
  });
  it('limits lists to 20 entries', () => {
    expect(WORKTREE_CONFIG_LIMITS.maxEntries).toBe(20);
    const n = (k: number, f: (i: number) => unknown) => Array.from({ length: k }, (_, i) => f(i));
    expect(bad({ setup: n(20, () => 'a') }).success).toBe(true);
    expect(bad({ setup: n(21, () => 'a') }).success).toBe(false);
    expect(bad({ teardown: n(21, () => 'a') }).success).toBe(false);
    expect(bad({ copy: n(21, (i) => `f${i}`) }).success).toBe(false);
    expect(bad({ services: n(21, (i) => ({ name: `s${i}`, command: 'x' })) }).success).toBe(false);
  });
  it('limits commands to 2000 chars', () => {
    const ok = 'a'.repeat(2000);
    const tooLong = 'a'.repeat(2001);
    expect(bad({ setup: [ok] }).success).toBe(true);
    expect(bad({ setup: [tooLong] }).success).toBe(false);
    expect(bad({ teardown: [tooLong] }).success).toBe(false);
    expect(bad({ services: [{ name: 'w', command: tooLong }] }).success).toBe(false);
    expect(bad({ checks: { build: tooLong } }).success).toBe(false);
    expect(bad({ setup: [''] }).success).toBe(false);
  });
  it('rejects absolute, parent-escaping and malformed copy paths', () => {
    for (const p of ['/etc/passwd', '../x', 'a/../../x', 'a/..', '..', '~/x', 'C:\\x', '\\\\srv\\x', 'a\\..\\b', '', 'a\0b']) {
      expect(bad({ copy: [p] }).success, p).toBe(false);
      expect(bad({ copy: [{ path: p }] }).success, `obj ${p}`).toBe(false);
    }
    expect(bad({ copy: ['.env', 'config/local.json', 'a..b/c'] }).success).toBe(true);
  });
  it('rejects bad copy mode and duplicate or bad service names, and two preview services', () => {
    expect(bad({ copy: [{ path: '.env', mode: 'move' }] }).success).toBe(false);
    expect(bad({ services: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }).success).toBe(false);
    expect(bad({ services: [{ name: 'a b', command: 'x' }] }).success).toBe(false);
    expect(
      bad({ services: [{ name: 'a', command: 'x', preview: true }, { name: 'b', command: 'y', preview: true }] }).success,
    ).toBe(false);
  });
  it('trims commands and rejects whitespace-only ones', () => {
    const r = bad({ setup: ['  pnpm install  '], checks: { build: ' pnpm build ' } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.setup).toEqual(['pnpm install']);
      expect(r.data.checks.build).toBe('pnpm build');
    }
    expect(bad({ setup: ['   '] }).success).toBe(false);
    expect(bad({ services: [{ name: 'w', command: ' \t' }] }).success).toBe(false);
    expect(bad({ checks: { test: '  ' } }).success).toBe(false);
  });
});

describe('WorktreeConfig v2: compose services', () => {
  const v2 = (services: unknown[]) => WorktreeConfig.safeParse({ version: 2, services });
  it('accepts version 2 with command and compose entries, defaulting the file to compose.yaml', () => {
    const r = v2([
      { name: 'dev', command: 'pnpm dev' },
      { name: 'web', compose: { service: 'web', port: 8080 }, preview: true },
      { name: 'api', compose: { file: 'deploy/compose.dev.yml', service: 'api.v2', port: 3000 } },
    ]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.version).toBe(2);
    expect(r.data.services[1]).toEqual({ name: 'web', compose: { file: 'compose.yaml', service: 'web', port: 8080 }, preview: true });
    expect(r.data.services[2]?.compose?.file).toBe('deploy/compose.dev.yml');
  });
  it('v1 files stay valid and unchanged', () => {
    expect(WorktreeConfig.parse(SPEC_EXAMPLE)).toMatchObject({ version: 1, services: SPEC_EXAMPLE.services });
  });
  it('rejects a compose entry in a version 1 file', () => {
    const r = WorktreeConfig.safeParse({ version: 1, services: [{ name: 'web', compose: { service: 'web', port: 80 } }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join()).toMatch(/version: 2/);
  });
  it('needs exactly one of command and compose', () => {
    expect(v2([{ name: 'web' }]).success).toBe(false);
    expect(v2([{ name: 'web', command: 'x', compose: { service: 'web', port: 80 } }]).success).toBe(false);
  });
  it('keeps keys strict in compose entries', () => {
    expect(v2([{ name: 'web', compose: { service: 'web', port: 80, ports: ['80:80'] } }]).success).toBe(false);
    expect(v2([{ name: 'web', compose: { service: 'web', port: 80 }, extra: true }]).success).toBe(false);
    expect(WorktreeConfig.safeParse({ version: 2, extra: 1 }).success).toBe(false);
  });
  it('validates the compose file, service and port', () => {
    const entry = (compose: Record<string, unknown>) => v2([{ name: 'web', compose: { service: 'web', port: 80, ...compose } }]).success;
    for (const file of ['/etc/compose.yaml', '../compose.yaml', 'a/../../c.yml', '-', '-f', '~/c.yml', 'C:\\c.yml', '', 'a\0b'])
      expect(entry({ file }), file).toBe(false);
    for (const service of ['', '-web', 'a b', 'web;rm', 'x'.repeat(64)]) expect(entry({ service }), service).toBe(false);
    for (const port of [0, 65536, 80.5, '80', -1]) expect(entry({ port }), String(port)).toBe(false);
    expect(entry({ port: 1 })).toBe(true);
    expect(entry({ port: 65535 })).toBe(true);
    expect(entry({ file: 'docker/compose.yml', service: 'web_1.a-b' })).toBe(true);
  });
  it('still allows at most one preview service across both kinds', () => {
    expect(
      v2([
        { name: 'a', command: 'x', preview: true },
        { name: 'b', compose: { service: 'b', port: 80 }, preview: true },
      ]).success,
    ).toBe(false);
  });
  it('rejects other versions', () => {
    expect(WorktreeConfig.safeParse({ version: 3 }).success).toBe(false);
  });
});

describe('editing worktree.yml from Project settings', () => {
  it('isWorktreeYmlPath normalizes the ways a client can name the file', () => {
    for (const rel of [
      '.emberline/worktree.yml',
      './.emberline/worktree.yml',
      '/.emberline//worktree.yml',
      '.emberline\\worktree.yml',
      'src/../.emberline/./worktree.yml',
    ]) {
      expect(isWorktreeYmlPath(rel), rel).toBe(true);
    }
    for (const rel of ['.emberline/worktree.yaml', 'x/.emberline/worktree.yml', '.emberline', 'worktree.yml']) {
      expect(isWorktreeYmlPath(rel), rel).toBe(false);
    }
  });

  it('isEmberlineDirPath names .emberline itself', () => {
    for (const rel of ['.emberline', './.emberline/', '/.emberline', '.emberline\\']) {
      expect(isEmberlineDirPath(rel), rel).toBe(true);
    }
    for (const rel of ['.emberline/worktree.yml', 'src/.emberline', '.emberlines']) {
      expect(isEmberlineDirPath(rel), rel).toBe(false);
    }
  });

  it('SaveWorktreeConfigBody caps the content at the worktree.yml size and wants a full sha or null', () => {
    const sha = 'a'.repeat(64);
    expect(SaveWorktreeConfigBody.safeParse({ content: 'x'.repeat(MAX_WORKTREE_YML_BYTES), baseSha256: sha }).success).toBe(true);
    expect(SaveWorktreeConfigBody.safeParse({ content: 'x'.repeat(MAX_WORKTREE_YML_BYTES + 1), baseSha256: sha }).success).toBe(false);
    // The cap counts bytes: 2-byte characters reach it at half the length.
    expect(SaveWorktreeConfigBody.safeParse({ content: 'é'.repeat(MAX_WORKTREE_YML_BYTES / 2 + 1), baseSha256: null }).success).toBe(false);
    expect(SaveWorktreeConfigBody.safeParse({ content: 'version: 1\n', baseSha256: 'a'.repeat(63) }).success).toBe(false);
    expect(SaveWorktreeConfigBody.safeParse({ content: 'version: 1\n', baseSha256: null }).success).toBe(true);
    expect(ValidateWorktreeConfigBody.safeParse({ content: 'x'.repeat(MAX_WORKTREE_YML_BYTES + 1) }).success).toBe(false);
  });
});

describe('container preview bodies', () => {
  it('take only the four compose file names, a compose service name and a port', () => {
    expect(ContainerPreviewChoice.safeParse({ file: 'compose.yaml', service: 'web', port: 8080 }).success).toBe(true);
    expect(ContainerPreviewChoice.safeParse({ file: 'deploy/compose.yaml', service: 'web', port: 8080 }).success).toBe(false);
    expect(ContainerPreviewChoice.safeParse({ file: 'compose.yaml', service: '-x', port: 8080 }).success).toBe(false);
    expect(ContainerPreviewChoice.safeParse({ file: 'compose.yaml', service: 'web', port: 0 }).success).toBe(false);
    expect(ContainerPreviewChoice.safeParse({ file: 'compose.yaml', service: 'web', port: 8080, extra: 1 }).success).toBe(false);
    expect(UseContainerPreviewBody.safeParse({ file: 'compose.yml', service: 'web', port: 80, baseSha256: null }).success).toBe(true);
    expect(UseContainerPreviewBody.safeParse({ file: 'compose.yml', service: 'web', port: 80 }).success).toBe(false);
  });
  it('lists the file names in the spec order', () => {
    expect(COMPOSE_FILE_NAMES).toEqual(['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);
  });
});
