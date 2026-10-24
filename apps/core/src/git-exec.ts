import { execCommand, execFileChecked, RUNNER_BIN, SYSTEM_PATH, systemCommand } from './command-exec.js';

/**
 * Core runs git inside repositories that agents control: worktrees share the main repo's
 * `.git/config`, and the runner can write it. Several config keys make git execute arbitrary
 * commands, so every git call from core neutralizes them on the command line (highest precedence)
 * and refuses repos whose config sets the ones that cannot be neutralized generically.
 *
 * Since Phase 3 every git process runs in the runner (command-exec.ts), so these settings protect
 * the runner's own credentials (SSH keys, OAuth tokens) from a repo planted by another agent. It is
 * the runner image's own git (`/usr/bin/git`), with ssh at `/usr/bin/ssh`: the runner's PATH starts
 * with directories agents can write (see SYSTEM_PATH).
 */
const SSH_COMMAND = `${RUNNER_BIN.ssh} -F /dev/null`;
/** The runner image's git-core (`git --exec-path`): root-owned, where git's own helpers live. */
const GIT_CORE_DIR = '/usr/lib/git-core';

const OVERRIDES: Record<string, string> = {
  'core.fsmonitor': 'false',
  'core.hooksPath': '/dev/null',
  // A repository's own hooks never run: this neutralizes the key when git reads this repository's
  // config (core.hooksPath on another repository git enters is handled by refusing those targets).
  'core.alternateRefsCommand': '',
  // Ignore ~/.ssh/config (runner-writable): a ProxyCommand there would run in core on push. The
  // system ssh by its path: a planted `ssh` earlier on PATH never runs.
  'core.sshCommand': SSH_COMMAND,
  // git asks this program for a password on a 401, even with GIT_TERMINAL_PROMPT=0; its prompt
  // holds the URL, so a token in it would be handed to the program. The env also empties GIT_ASKPASS.
  'core.askPass': '',
  'core.pager': 'cat',
  'core.editor': 'true',
  'sequence.editor': 'true',
  // An empty value resets the helper list.
  'credential.helper': '',
  'commit.gpgSign': 'false',
  'tag.gpgSign': 'false',
  'protocol.ext.allow': 'never',
  // git's own default, pinned: a repository's config never widens it (`always` would let a
  // submodule be fetched or pushed over the file transport). Remote commands pin it to `never`.
  'protocol.file.allow': 'user',
};

export const HARDENED_GIT_ARGS: readonly string[] = Object.entries(OVERRIDES).flatMap(([key, value]) => [
  '-c',
  `${key}=${value}`,
]);

/**
 * For every git command that reaches a remote over http(s): TLS as git's defaults have it, no proxy
 * and no extra header from any config. `-c` wins over a config file's unscoped key; a URL-scoped one
 * (`http.<url>.sslVerify`) would win over it, so those, and the TLS keys that cannot be reset to
 * git's default (`http.sslCAInfo`, `http.sslCert`, …), are refused on remote commands (see
 * {@link assertSafeGitConfig}). An empty `http.extraHeader` resets the list.
 */
export const REMOTE_HTTP_ARGS: readonly string[] = [
  '-c',
  'http.sslVerify=true',
  '-c',
  'http.proxy=',
  '-c',
  'http.extraHeader=',
];

/**
 * The transports a git command that reaches a remote may use: https, http and ssh, and nothing
 * else. `protocol.allow=never` makes every scheme default to `never`, and the explicit allows name
 * the three. So `file` (a local path), `ext` (a command), `git` (unauthenticated) and the rest are
 * refused by git itself, whatever any config says, which closes the hole where git runs another
 * repository's hooks or helpers when it reaches a local path. The product refuses such targets with
 * a clear message first (see assertSupportedRemote); this is the backstop.
 */
export const REMOTE_PROTOCOL_ARGS: readonly string[] = [
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.http.allow=always',
  '-c',
  'protocol.ssh.allow=always',
  ...REMOTE_HTTP_ARGS,
];

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

/**
 * Repo config keys that run commands, route traffic or pick a target and have no safe generic
 * override. A URL-scoped `http.<url>.proxy` wins over the `-c http.proxy=` core passes, whatever the
 * order, so it could route the capability URL through a proxy of the agent's choosing; it is refused
 * (the unscoped `http.proxy` is overridden by `-c`). `remote.*.proxy` likewise.
 */
const BLOCKED_CONFIG_KEY =
  /^(diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|merge\..+\.driver|include\.path|includeif\..+\.path|remote\..+\.(uploadpack|receivepack|vcs|proxy)|url\..+\.(insteadof|pushinsteadof)|http\..+\.proxy|core\.(gitproxy|alternaterefscommand)|gpg\.program|gpg\..+\.program)$/i;

/**
 * Refused only on commands that reach a remote ({@link REMOTE_HTTP_ARGS}): every TLS key, plain or
 * URL-scoped (`http.sslCAInfo`, `http.<url>.sslVerify`, a client certificate or key, the TLS
 * backend, version, ciphers, a pinned key), except the plain `http.sslVerify` that `-c` pins; and a
 * URL-scoped `http.<url>.extraHeader`, which wins over the reset. They would weaken or redirect TLS
 * for origin's address and its credential.
 */
const REMOTE_BLOCKED_CONFIG_KEY =
  /^http\.(.+\.)?(ssl[a-z]*|pinnedpubkey|schannel[a-z]*)$|^http\..+\.extraheader$/i;
const PINNED_REMOTE_KEY = /^http\.sslverify$/i;

/**
 * The whole environment of every git process core runs: nothing from core's environment or the
 * runner's is forwarded (`inheritEnv: false`), so no `GIT_*`, proxy, TLS, `LD_*` or `HOME` variable
 * an agent could set reaches it.
 * - `PATH` is the system one and `GIT_EXEC_PATH` the image's git-core, so git's helpers
 *   (`git-remote-https`) and ssh are the image's own; `GIT_SSH_COMMAND` is core's ssh command.
 * - System and global config live in images/volumes the runner can influence, so both are disabled.
 *   This also stops git reading `$XDG_CONFIG_HOME/git/config` (git looks there only when
 *   GIT_CONFIG_GLOBAL is unset). `HOME` names no directory, so no `~/.config/git/attributes` or
 *   `ignore` applies either; ssh finds its keys from the passwd entry, not `HOME`, and its own config
 *   is pinned with `core.sshCommand`.
 * - `TZ` is core's own (the runner had the same), so commits core makes keep their time zone.
 * - No password prompt: `GIT_TERMINAL_PROMPT=0`, and an empty `GIT_ASKPASS`/`SSH_ASKPASS` (git and
 *   ssh treat an empty value as unset) with `core.askPass=` in the args, so neither a config key nor
 *   an inherited env var can run an askpass program (R7-I2).
 */
export function hardenedGitEnv(): Record<string, string> {
  return {
    PATH: SYSTEM_PATH,
    HOME: '/nonexistent',
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    GIT_EXEC_PATH: GIT_CORE_DIR,
    GIT_SSH_COMMAND: SSH_COMMAND,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
  };
}

export class UnsafeGitConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`refusing to run git: repository config sets keys Emberline does not allow (${keys.join(', ')})`);
    this.name = 'UnsafeGitConfigError';
  }
}

/**
 * Throws when the repository config (including files it includes) sets a blocked key; `remote`: also
 * a key that would weaken TLS or add a header on a command that reaches a remote.
 */
export async function assertSafeGitConfig(cwd: string, { remote = false } = {}): Promise<void> {
  const res = await execCommand(
    systemCommand({
      file: RUNNER_BIN.git,
      args: ['-C', cwd, 'config', '--list', '--name-only'],
      cwd: '/',
      env: hardenedGitEnv(),
      timeoutMs: 10_000,
    }),
  );
  if (res.exitCode !== 0) {
    // Outside a repository this still succeeds (system/global config are disabled), so a failure
    // means config git cannot parse, e.g. an include pointing at a non-config file. Fail closed.
    throw new UnsafeGitConfigError([res.stderr.trim().split('\n')[0] || 'unreadable config']);
  }
  const blocked = res.stdout
    .split('\n')
    .map((key) => key.trim())
    .filter(
      (key) =>
        key &&
        (BLOCKED_CONFIG_KEY.test(key) ||
          (remote && REMOTE_BLOCKED_CONFIG_KEY.test(key) && !PINNED_REMOTE_KEY.test(key))),
    );
  if (blocked.length > 0) throw new UnsafeGitConfigError([...new Set(blocked)]);
}

/**
 * The environment for a git clone run in a ptyd terminal (import): the same hardening as {@link
 * execGitFile} (no global or system config, no prompt, no askpass), plus `LC_ALL=C` when a branch
 * was given so import-status can read git's English "Remote branch … not found". ptyd takes string
 * values only.
 */
export function cloneGitEnv(branchGiven: boolean): Record<string, string> {
  return { ...hardenedGitEnv(), ...(branchGiven ? { LC_ALL: 'C' } : {}) };
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
  /**
   * The command reaches a remote: restrict the transports to https/http/ssh and pin TLS, proxy and
   * extra headers ({@link REMOTE_PROTOCOL_ARGS}), and refuse config that weakens TLS. The caller has
   * already refused a local-path or file target with a clear message (assertSupportedRemote); this
   * makes git refuse it too.
   */
  remote?: boolean;
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
  await assertSafeGitConfig(repo, { remote: options.remote });
  const { stdout, stderr } = await execFileChecked(
    systemCommand({
      file: RUNNER_BIN.git,
      args: [...HARDENED_GIT_ARGS, ...(options.remote ? REMOTE_PROTOCOL_ARGS : []), ...args],
      cwd: options.cwd ?? '/',
      env: { ...gitVariables(options.env), ...hardenedGitEnv() },
      timeoutMs: options.timeout ?? 30_000,
      maxOutputBytes: options.maxBuffer,
      encoding: options.encoding === 'buffer' ? 'base64' : 'utf8',
    }),
  );
  return { stdout: options.encoding === 'buffer' ? Buffer.from(stdout, 'base64') : stdout, stderr };
}
