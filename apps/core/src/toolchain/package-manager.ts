import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type CommandOutcome, runWorktreeCommand } from '../worktree-config/lifecycle.js';

/**
 * Package managers Emberline provisions for a worktree's setup. npm ships with Node, and yarn
 * projects keep whatever yarn the runner has (yarn berry vendors its own release in the repo).
 */
export type ProvisionedManager = 'pnpm';

export interface DeclaredPackageManager {
  name: 'pnpm' | 'yarn' | 'npm';
  /** An exact version (`10.15.0`, `9.0.0-rc.1`): the only form written into a shell command. */
  version: string;
}

/** Strict semver: anything else (ranges, tags, URLs) is refused, so it never reaches a shell. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const PACKAGE_JSON = z.object({ packageManager: z.string().optional() });

/** Parses package.json's `packageManager` (`pnpm@10.15.0`, optionally `+sha512.…`); null otherwise. */
export function parsePackageManagerField(value: string): DeclaredPackageManager | null {
  const match = /^(pnpm|yarn|npm)@([^+\s]+)(?:\+[A-Za-z0-9.=/+-]+)?$/.exec(value.trim());
  if (!match) return null;
  const [, name, version] = match;
  if (!version || !EXACT_VERSION.test(version)) return null;
  return { name: name as DeclaredPackageManager['name'], version };
}

/** The `packageManager` the worktree's root package.json declares; null without a valid one. */
export function readDeclaredPackageManager(worktreePath: string): DeclaredPackageManager | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(worktreePath, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PACKAGE_JSON.safeParse(json);
  if (!parsed.success || !parsed.data.packageManager) return null;
  return parsePackageManagerField(parsed.data.packageManager);
}

/** Whether one of the commands runs `binary` as a command word (not as part of a path or name). */
export function setupInvokes(setup: readonly string[], binary: string): boolean {
  const word = new RegExp(`(^|[\\s;&|(\`])${binary}(?=$|[\\s;&|)\`])`);
  return setup.some((command) => word.test(command));
}

/**
 * The package manager to make sure of before `setup` runs: the declared one, when the setup names
 * it and Emberline provisions it (pnpm). null for npm and yarn projects.
 */
export function managerToProvision(
  worktreePath: string,
  setup: readonly string[],
): (DeclaredPackageManager & { name: ProvisionedManager }) | null {
  const declared = readDeclaredPackageManager(worktreePath);
  if (!declared || declared.name !== 'pnpm') return null;
  if (!setupInvokes(setup, declared.name)) return null;
  return { name: declared.name, version: declared.version };
}

const PRESENT_MARKER = 'emberline-pm: present';
const INSTALLED_MARKER = 'emberline-pm: installed';

/**
 * The runner-side script: nothing when the binary is on PATH (pnpm itself then switches to the
 * declared version), else `npm install -g <name>@<version>` into the persistent runner-tools volume,
 * whose npm/bin is on the runner's PATH.
 */
export function provisionScript(manager: DeclaredPackageManager, toolsDir: string): string {
  const prefix = path.join(toolsDir, 'npm');
  const spec = `${manager.name}@${manager.version}`;
  return [
    `if command -v ${manager.name} >/dev/null 2>&1; then echo "${PRESENT_MARKER}"; exit 0; fi`,
    `export NPM_CONFIG_PREFIX='${prefix.replace(/'/g, "'\\''")}'`,
    'mkdir -p "$NPM_CONFIG_PREFIX/bin" "$NPM_CONFIG_PREFIX/lib"',
    `npm install -g --no-audit --no-fund ${spec} || exit $?`,
    `command -v ${manager.name} >/dev/null 2>&1 || { echo "${spec} was installed to $NPM_CONFIG_PREFIX/bin, which is not on the runner's PATH"; exit 127; }`,
    `echo "${INSTALLED_MARKER}"`,
  ].join('\n');
}

export type ProvisionOutcome =
  | { status: 'not_needed' }
  | { status: 'present'; manager: ProvisionedManager; version: string }
  | { status: 'installed'; manager: ProvisionedManager; version: string; message: string }
  | { status: 'cancelled'; manager: ProvisionedManager; version: string }
  | {
      status: 'failed';
      manager: ProvisionedManager;
      version: string;
      outcome: Pick<CommandOutcome, 'exitCode' | 'timedOut' | 'tail'>;
    };

export const PROVISION_TIMEOUT_MS = 3 * 60_000;

/** The runner-tools volume as core knows it (the same variable ToolchainService reads). */
export const runnerToolsDir = (): string => process.env.EMBERLINE_TOOLS_DIR ?? '/opt/ai-tools';

/**
 * Makes sure the package manager that package.json pins is on the runner's PATH before the
 * worktree's `setup` runs it, so a missing pnpm is an install, not an exit 127. Never throws.
 */
export async function ensureSetupPackageManager(
  worktreePath: string,
  setup: readonly string[],
  options: { timeoutMs?: number; execId?: string; env?: Record<string, string> } = {},
): Promise<ProvisionOutcome> {
  const manager = managerToProvision(worktreePath, setup);
  if (!manager) return { status: 'not_needed' };
  const outcome = await runWorktreeCommand(
    provisionScript(manager, runnerToolsDir()),
    worktreePath,
    Math.min(options.timeoutMs ?? PROVISION_TIMEOUT_MS, PROVISION_TIMEOUT_MS),
    options.execId,
    options.env,
  );
  const base = { manager: manager.name, version: manager.version };
  if (outcome.cancelled) return { status: 'cancelled', ...base };
  if (!outcome.ok) {
    return {
      status: 'failed',
      ...base,
      outcome: { exitCode: outcome.exitCode, timedOut: outcome.timedOut, tail: outcome.tail },
    };
  }
  if (outcome.tail.includes(INSTALLED_MARKER)) {
    return {
      status: 'installed',
      ...base,
      message: `Installed ${manager.name} ${manager.version} for setup`,
    };
  }
  return { status: 'present', ...base };
}
