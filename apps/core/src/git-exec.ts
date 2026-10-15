import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Core runs git inside repositories that agents control: worktrees share the main repo's
 * `.git/config`, and the runner can write it. Several config keys make git execute arbitrary
 * commands, so every git call from core neutralizes them on the command line (highest precedence)
 * and refuses repos whose config sets the ones that cannot be neutralized generically.
 *
 * The lasting fix is running git in the runner (ROADMAP Phase 3); this closes the known paths.
 */
const OVERRIDES: Record<string, string> = {
  'core.fsmonitor': 'false',
  'core.hooksPath': '/dev/null',
  // Ignore ~/.ssh/config (runner-writable): a ProxyCommand there would run in core on push.
  'core.sshCommand': 'ssh -F /dev/null',
  'core.pager': 'cat',
  'core.editor': 'true',
  'sequence.editor': 'true',
  // An empty value resets the helper list.
  'credential.helper': '',
  'commit.gpgSign': 'false',
  'tag.gpgSign': 'false',
  'protocol.ext.allow': 'never',
};

export const HARDENED_GIT_ARGS: readonly string[] = Object.entries(OVERRIDES).flatMap(([key, value]) => [
  '-c',
  `${key}=${value}`,
]);

/** Repo config keys that run commands and have no safe generic override. */
const BLOCKED_CONFIG_KEY =
  /^(diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|merge\..+\.driver|include\.path|includeif\..+\.path|remote\..+\.(uploadpack|receivepack|vcs)|url\..+\.(insteadof|pushinsteadof)|core\.(gitproxy|alternaterefscommand)|gpg\.program|gpg\..+\.program)$/i;

export function hardenedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // System and global config live in images/volumes the runner can influence.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export class UnsafeGitConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`refusing to run git: repository config sets command-executing keys (${keys.join(', ')})`);
    this.name = 'UnsafeGitConfigError';
  }
}

/** Throws when the repository config (including files it includes) sets a blocked key. */
export async function assertSafeGitConfig(cwd: string): Promise<void> {
  let listing: string;
  try {
    ({ stdout: listing } = await execFileAsync('git', ['-C', cwd, 'config', '--list', '--name-only'], {
      timeout: 10_000,
      env: hardenedGitEnv(),
    }));
  } catch (err) {
    // Outside a repository this still succeeds (system/global config are disabled), so a failure
    // means config git cannot parse, e.g. an include pointing at a non-config file. Fail closed.
    const detail = (err as { stderr?: string }).stderr?.trim().split('\n')[0] ?? 'unreadable config';
    throw new UnsafeGitConfigError([detail]);
  }
  const blocked = listing
    .split('\n')
    .map((key) => key.trim())
    .filter((key) => key && BLOCKED_CONFIG_KEY.test(key));
  if (blocked.length > 0) throw new UnsafeGitConfigError([...new Set(blocked)]);
}

export interface RunGitOptions {
  timeout?: number;
  maxBuffer?: number;
}

/** Runs `git -C cwd <args>` with the hardened config and environment; returns raw stdout. */
export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
  await assertSafeGitConfig(cwd);
  const { stdout } = await execFileAsync('git', [...HARDENED_GIT_ARGS, '-C', cwd, ...args], {
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    env: hardenedGitEnv(),
  });
  return stdout;
}

/** Binary-safe variant of {@link runGit} (e.g. `git show <blob>`). */
export async function runGitBuffer(cwd: string, args: string[], options: RunGitOptions = {}): Promise<Buffer> {
  await assertSafeGitConfig(cwd);
  const { stdout } = await execFileAsync('git', [...HARDENED_GIT_ARGS, '-C', cwd, ...args], {
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    env: hardenedGitEnv(),
    encoding: 'buffer',
  });
  return stdout;
}

export interface ExecGitOptions {
  /** Repository directory; defaults to the path after a leading `-C` in `args`. */
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

function repoDirOf(args: string[], options: ExecGitOptions): string {
  if (options.cwd) return options.cwd;
  if (args[0] === '-C' && args[1]) return args[1];
  return process.cwd();
}

/**
 * Drop-in for `execFileAsync('git', args, options)` with the hardened config and environment.
 * Caller env vars are kept, but cannot re-enable system/global config.
 */
export async function execGitFile(
  args: string[],
  options: ExecGitOptions & { encoding: 'buffer' },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function execGitFile(args: string[], options?: ExecGitOptions): Promise<{ stdout: string; stderr: string }>;
export async function execGitFile(
  args: string[],
  options: ExecGitOptions & { encoding?: 'buffer' } = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  await assertSafeGitConfig(repoDirOf(args, options));
  const { env, encoding, ...rest } = options;
  return execFileAsync('git', [...HARDENED_GIT_ARGS, ...args], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    ...rest,
    ...(encoding ? { encoding } : {}),
    env: { ...(env ?? process.env), ...pick(hardenedGitEnv(), ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT']) },
  });
}

function pick(env: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.map((key) => [key, env[key]]));
}
