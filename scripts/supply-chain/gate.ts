// Release supply-chain gate (CI job `supply-chain`; locally `make supply-chain`).
//   node scripts/supply-chain/gate.ts [builds|audit]   (no argument: both)
// Run after `pnpm install --frozen-lockfile`. Exits 1 when a check fails.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit, parseAllowlist, parseAuditReport, type Advisory } from './audit.ts';
import { evaluateBuilds, parseIgnoredBuilds, readBuildConfig } from './builds.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const ALLOWLIST = join(here, 'audit-allowlist.json');
const inActions = process.env.GITHUB_ACTIONS === 'true';

function say(level: 'error' | 'warning' | 'info', message: string): void {
  const prefix = level === 'info' ? '' : inActions ? `::${level}::` : `${level}: `;
  process.stdout.write(`${prefix}${message}\n`);
}

function pnpm(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkBuilds(): boolean {
  const config = readBuildConfig(readFileSync(join(root, 'package.json'), 'utf8'));
  const listing = pnpm(['ignored-builds']);
  if (listing.status !== 0)
    throw new Error(`pnpm ignored-builds exited ${listing.status}: ${listing.stderr}`);
  const others = ['pnpm-workspace.yaml', '.npmrc']
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
  const problems = evaluateBuilds(config, parseIgnoredBuilds(listing.stdout), others);
  for (const problem of problems) say('error', `build scripts: ${problem}`);
  if (problems.length === 0) {
    say('info', `build scripts: only ${config.onlyBuiltDependencies.join(', ')} run install scripts`);
  }
  return problems.length === 0;
}

const describe = (advisory: Advisory): string =>
  `${advisory.severity} ${advisory.ghsa} in ${advisory.module}: ${advisory.title} ${advisory.url} (${advisory.paths.slice(0, 3).join('; ')})`;

function checkAudit(): boolean {
  const allowlist = parseAllowlist(readFileSync(ALLOWLIST, 'utf8'));
  const report = pnpm(['audit', '--prod', '--json']);
  const advisories = parseAuditReport(report.stdout);
  const verdict = evaluateAudit(advisories, allowlist, new Date().toISOString().slice(0, 10));

  for (const advisory of verdict.blocking) say('error', `audit: ${describe(advisory)}`);
  for (const entry of verdict.expired) {
    say(
      'error',
      `audit allowlist: ${entry.id} (${entry.package}) expired on ${entry.expires}; fix or re-review it`,
    );
  }
  for (const advisory of verdict.allowed) say('warning', `audit: allowlisted ${describe(advisory)}`);
  for (const entry of verdict.unused) {
    say('warning', `audit allowlist: ${entry.id} (${entry.package}) no longer matches; remove it`);
  }
  const ok = verdict.blocking.length === 0 && verdict.expired.length === 0;
  if (ok)
    say(
      'info',
      `audit: no unallowlisted high or critical advisory (${advisories.length} lower or allowlisted)`,
    );
  return ok;
}

const CHECKS: Record<string, () => boolean> = { builds: checkBuilds, audit: checkAudit };
const which = process.argv[2];
const selected = which === undefined ? Object.values(CHECKS) : [CHECKS[which]];
let failed = false;
for (const check of selected) {
  if (check === undefined) {
    say('error', `unknown check "${which}"; use builds, audit or nothing for both`);
    process.exit(2);
  }
  try {
    failed = !check() || failed;
  } catch (error) {
    say('error', error instanceof Error ? error.message : String(error));
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
