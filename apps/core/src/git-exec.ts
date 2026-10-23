import { execCommand, execFileChecked } from './command-exec.js';

/**
 * Core runs git inside repositories that agents control: worktrees share the main repo's
 * `.git/config`, and the runner can write it. Several config keys make git execute arbitrary
 * commands, so every git call from core neutralizes them on the command line (highest precedence)
 * and refuses repos whose config sets the ones that cannot be neutralized generically.
 *
 * Since Phase 3 every git process runs in the runner (command-exec.ts), so these settings protect
 * the runner's own credentials (SSH keys, OAuth tokens) from a repo planted by another agent.
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
  // git's own default, pinned: a repository's config never widens it (`always` would let a
  // submodule be fetched or pushed over the file transport).
  'protocol.file.allow': 'user',
};

export const HARDENED_GIT_ARGS: readonly string[] = Object.entries(OVERRIDES).flatMap(([key, value]) => [
  '-c',
  `${key}=${value}`,
]);

/**
 * For every git command that reaches a remote with a credential (the account's capability URL, a
 * token in origin's address): it never recurses into a submodule, whatever the repository's config
 * says, so no command a submodule's own config sets runs and no other remote is reached. `-c` wins
 * over every config file, and reaches a child git too.
 */
export const NO_SUBMODULES: readonly string[] = [
  '-c',
  'submodule.recurse=false',
  '-c',
  'push.recurseSubmodules=no',
  '-c',
  'fetch.recurseSubmodules=false',
];

/** Repo config keys that run commands and have no safe generic override. */
const BLOCKED_CONFIG_KEY =
  /^(diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|merge\..+\.driver|include\.path|includeif\..+\.path|remote\..+\.(uploadpack|receivepack|vcs)|url\..+\.(insteadof|pushinsteadof)|core\.(gitproxy|alternaterefscommand)|gpg\.program|gpg\..+\.program)$/i;

/** Hardening variables for every git process; nothing else from core's environment is forwarded. */
export function hardenedGitEnv(): Record<string, string> {
  return {
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
  const res = await execCommand({
    file: 'git',
    args: ['-C', cwd, 'config', '--list', '--name-only'],
    cwd: '/',
    env: hardenedGitEnv(),
    timeoutMs: 10_000,
  });
  if (res.exitCode !== 0) {
    // Outside a repository this still succeeds (system/global config are disabled), so a failure
    // means config git cannot parse, e.g. an include pointing at a non-config file. Fail closed.
    throw new UnsafeGitConfigError([res.stderr.trim().split('\n')[0] || 'unreadable config']);
  }
  const blocked = res.stdout
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
  return (await execGitFile(['-C', cwd, ...args], options)).stdout;
}

/** Binary-safe variant of {@link runGit} (e.g. `git show <blob>`). */
export async function runGitBuffer(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<Buffer> {
  return (await execGitFile(['-C', cwd, ...args], { ...options, encoding: 'buffer' })).stdout;
}

export interface ExecGitOptions {
  /** Repository directory; defaults to the path after a leading `-C` in `args`. */
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  /** Extra `GIT_*` variables (other keys are dropped); hardening variables always win. */
  env?: Record<string, string | undefined>;
}

function repoDirOf(args: string[], options: ExecGitOptions): string {
  if (options.cwd) return options.cwd;
  if (args[0] === '-C' && args[1]) return args[1];
  throw new Error('execGitFile needs a repository: pass options.cwd or start args with -C <dir>');
}

function gitVariables(env: ExecGitOptions['env']): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.startsWith('GIT_') && value !== undefined) picked[key] = value;
  }
  return picked;
}

/**
 * Hardened replacement for `execFileAsync('git', args, options)`: runs in the runner (see
 * command-exec.ts), resolves on exit code 0 and rejects with stdout/stderr/code otherwise.
 */
export async function execGitFile(
  args: string[],
  options: ExecGitOptions & { encoding: 'buffer' },
): Promise<{ stdout: Buffer; stderr: string }>;
export async function execGitFile(
  args: string[],
  options?: ExecGitOptions,
): Promise<{ stdout: string; stderr: string }>;
export async function execGitFile(
  args: string[],
  options: ExecGitOptions & { encoding?: 'buffer' } = {},
): Promise<{ stdout: string | Buffer; stderr: string }> {
  const repo = repoDirOf(args, options);
  await assertSafeGitConfig(repo);
  const { stdout, stderr } = await execFileChecked({
    file: 'git',
    args: [...HARDENED_GIT_ARGS, ...args],
    cwd: options.cwd ?? '/',
    env: { ...gitVariables(options.env), ...hardenedGitEnv() },
    timeoutMs: options.timeout ?? 30_000,
    maxOutputBytes: options.maxBuffer,
    encoding: options.encoding === 'buffer' ? 'base64' : 'utf8',
  });
  return { stdout: options.encoding === 'buffer' ? Buffer.from(stdout, 'base64') : stdout, stderr };
}
