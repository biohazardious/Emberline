import { badRequest, HttpError } from '../errors.js';
import { remoteUrlForDisplay } from '../forge/hosts.js';
import { parseForgeRemote } from '../forge/service.js';
import { execGitFile } from '../git-exec.js';
import { describeGitError } from '../git-gateway/gateway.js';
import {
  type AccountRemote,
  accountFetchBranchObjects,
  accountPushBranch,
  accountRemoteBranches,
  accountRemoteHead,
} from '../git-gateway/remote-git.js';

export const MAIN_MOVED_MESSAGE =
  "Main's latest commit is not this merge, so Keep main pushed did not push it. Check main, then push it from Project settings → Repository.";
export const MERGE_UNVERIFIED_MESSAGE =
  'Main changed during the merge; Emberline did not record it for pushing.';
export const DIVERGED_MESSAGE =
  "The remote's main has commits this project doesn't have. Pull them in from a terminal, then push again.";
const CREDENTIALS_IN_URL = 'Remove the user name and token from the URL; Emberline uses the forge account.';
const BAD_URL =
  'Enter a repository URL such as https://github.com/you/app.git or git@github.com:you/app.git.';

/**
 * How origin is reached. With an account (an http(s) URL under its server) the runner's git goes
 * through core's gateway, which adds the credential, and the token never leaves core; otherwise
 * (ssh with the runner's keys, a public https remote) the runner's git goes straight to the URL.
 */
export interface RemoteAccess {
  /** projects.repoUrl, or the URL being connected: never a URL read from .git/config. */
  url: string;
  account: AccountRemote | null;
}

/** The first useful line of a failed gateway or git call (no token, no capability), at most 300 characters. */
export function shortGitError(error: unknown): string {
  return describeGitError(error);
}

export { remoteUrlForDisplay };

/** A forge remote (https, http, ssh, scp-like) Emberline may store as origin. */
export function validateRepositoryUrl(raw: string): {
  url: string;
  host: string;
  transport: 'https' | 'http' | 'ssh';
} {
  // The scheme lower-case: git and parseForgeRemote only know `https://`, not `HTTPS://`.
  const url = raw.trim().replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, (scheme) => scheme.toLowerCase());
  // `<transport>::<address>` is git's remote-helper form (ext::, fd::); `[::1]` in a host is not.
  // eslint-disable-next-line no-control-regex
  if (!url || url.startsWith('-') || /[\s\u0000-\u001f]/.test(url) || /^[A-Za-z0-9+.-]*::/.test(url))
    throw badRequest(BAD_URL);
  let transport: 'https' | 'http' | 'ssh';
  if (/^https?:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest(BAD_URL);
    }
    if (parsed.username || parsed.password) throw badRequest(CREDENTIALS_IN_URL);
    // A query or fragment can carry a token (`?private_token=`) and is no part of a repository's address.
    if (parsed.search || parsed.hash) throw badRequest(BAD_URL);
    transport = parsed.protocol === 'http:' ? 'http' : 'https';
  } else if (/^ssh:\/\//.test(url) || /^[^/:]+@?[^/:]*:[^/]/.test(url)) {
    // A password in an ssh URL (`ssh://user:pw@host`, `user:pw@host:path`) is a credential too.
    if (/^ssh:\/\/[^/@]*:[^/@]*@/.test(url) || /^[^/@]*:[^/@]*@/.test(url))
      throw badRequest(CREDENTIALS_IN_URL);
    transport = 'ssh';
  } else {
    throw badRequest(BAD_URL);
  }
  const remote = parseForgeRemote(url);
  if (!remote || remote.host.startsWith('-')) throw badRequest(BAD_URL);
  return { url, host: remote.host, transport };
}

export async function mainBranchState(
  mainPath: string,
): Promise<{ branch: string | null; hasCommits: boolean }> {
  const ref = await execGitFile(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: mainPath }).catch(
    () => ({ stdout: '' }),
  );
  const head = await execGitFile(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: mainPath }).catch(
    () => ({ stdout: '' }),
  );
  return { branch: ref.stdout.trim() || null, hasCommits: Boolean(head.stdout.trim()) };
}

/**
 * Git that reads only the real objects: no replace refs, no `info/grafts`, no commit-graph (agents
 * can write all three in the shared repository to make a commit look like another).
 */
const REAL_OBJECTS_ENV = { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
const realGit = (args: string[], cwd: string) =>
  execGitFile(['-c', 'core.commitGraph=false', '-c', 'core.useReplaceRefs=false', ...args], {
    cwd,
    env: REAL_OBJECTS_ENV,
  });

/** The commit `refs/heads/<branch>` names now, with its subject; null when the branch has no commit. */
export async function branchTip(
  mainPath: string,
  branch: string,
): Promise<{ sha: string; shortSha: string; subject: string } | null> {
  const out = await realGit(
    ['log', '-1', '--no-show-signature', '--format=%H%x00%h%x00%s', `refs/heads/${branch}`, '--'],
    mainPath,
  ).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  const [sha, shortSha, subject] = out.split('\0');
  return sha && shortSha ? { sha, shortSha, subject: subject ?? '' } : null;
}

/** Whether `ancestor` is `commit` or one of its ancestors, in the real objects; any failure is "no". */
export async function isAncestorCommit(mainPath: string, ancestor: string, commit: string): Promise<boolean> {
  return realGit(['merge-base', '--is-ancestor', ancestor, commit], mainPath).then(
    () => true,
    () => false,
  );
}

export async function originUrls(mainPath: string): Promise<{ fetch: string | null; push: string | null }> {
  const read = async (args: string[]) =>
    (await execGitFile(args, { cwd: mainPath }).catch(() => ({ stdout: '' }))).stdout.trim() || null;
  return {
    fetch: await read(['remote', 'get-url', 'origin']),
    push: await read(['remote', 'get-url', '--push', 'origin']),
  };
}

/** Branch names on the remote (empty: an empty repository), or only `branch` when given. */
export async function listRemoteBranches(
  mainPath: string,
  access: RemoteAccess,
  branch?: string,
): Promise<string[]> {
  const names = access.account
    ? await accountRemoteBranches(access.account, mainPath, branch)
    : (
        await execGitFile(
          ['ls-remote', '--heads', '--', access.url, ...(branch ? [`refs/heads/${branch}`] : [])],
          { cwd: mainPath, timeout: 20_000 },
        )
      ).stdout
        .split('\n')
        .map((line) => line.split('\t')[1]?.trim() ?? '')
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length));
  return branch ? names.filter((name) => name === branch) : names;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The commit `refs/heads/<branch>` names on the remote; null when it has no such branch. */
export async function remoteBranchHead(
  mainPath: string,
  access: RemoteAccess,
  branch: string,
): Promise<string | null> {
  if (access.account) return accountRemoteHead(access.account, mainPath, branch);
  const out = (
    await execGitFile(['ls-remote', '--heads', '--', access.url, `refs/heads/${branch}`], {
      cwd: mainPath,
      timeout: 20_000,
    })
  ).stdout;
  for (const line of out.split('\n')) {
    const [oid, ref] = line.split('\t');
    if (ref?.trim() === `refs/heads/${branch}` && OID.test(oid?.trim() ?? '')) return oid!.trim();
  }
  return null;
}

const hasRealCommit = (cwd: string, oid: string) =>
  realGit(['cat-file', '-e', `${oid}^{commit}`], cwd).then(
    () => true,
    () => false,
  );

/**
 * The remote branch's objects, so `oid` (what ls-remote reported) can be read locally. No ref and no
 * FETCH_HEAD is written: no main-workspace lock is needed, and the caller sets the tracking ref.
 */
export async function fetchBranchObjects(
  mainPath: string,
  access: RemoteAccess,
  branch: string,
  oid: string,
): Promise<void> {
  if (await hasRealCommit(mainPath, oid)) return;
  if (access.account) await accountFetchBranchObjects(access.account, mainPath, branch);
  else
    await execGitFile(
      [
        '-c',
        'fetch.writeCommitGraph=false',
        '-c',
        'maintenance.auto=false',
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--refmap=',
        '--',
        access.url,
        `refs/heads/${branch}`,
      ],
      { cwd: mainPath, timeout: 30_000 },
    );
  // The remote moved on between ls-remote and the fetch.
  if (!(await hasRealCommit(mainPath, oid)))
    throw new HttpError(409, 'remote_moved', "origin's main changed while Emberline read it. Press Refresh again.");
}

/** Points `refs/remotes/origin/<branch>` at `oid`. Local only; the caller holds the main-workspace lock. */
export async function setRemoteTracking(mainPath: string, branch: string, oid: string): Promise<void> {
  await execGitFile(['update-ref', '-m', 'emberline: origin read', `refs/remotes/origin/${branch}`, oid], {
    cwd: mainPath,
  });
}

export async function aheadBehind(
  mainPath: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  const out = (
    await realGit(
      ['rev-list', '--left-right', '--count', `refs/heads/${branch}...refs/remotes/origin/${branch}`],
      mainPath,
    )
  ).stdout;
  const [ahead, behind] = out.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

/**
 * Pushes `oid` (read by the caller under the main-workspace lock) to `refs/heads/<branch>` at the
 * access URL: never forced, never tags. Writes nothing locally (no lock needed); the caller sets the
 * tracking ref and upstream under the lock.
 */
export async function pushBranch(
  mainPath: string,
  access: RemoteAccess,
  branch: string,
  oid: string,
): Promise<'pushed' | 'rejected'> {
  const ref = `refs/heads/${branch}`;
  if (access.account) {
    try {
      return await accountPushBranch(access.account, mainPath, branch, oid);
    } catch (error) {
      throw new HttpError(
        409,
        'push_failed',
        `Push failed: ${describeGitError(error, access.account.credential)}`,
      );
    }
  } else {
    try {
      await execGitFile(
        [
          'push',
          '--porcelain',
          '--no-recurse-submodules',
          '--no-follow-tags',
          '--',
          access.url,
          `${oid}:${ref}`,
        ],
        { cwd: mainPath, timeout: 60_000 },
      );
      return 'pushed';
    } catch (error) {
      const out = `${String((error as { stdout?: unknown }).stdout ?? '')}\n${String((error as { stderr?: unknown }).stderr ?? '')}`;
      // Only a non-fast-forward is "the remote has commits main doesn't"; a `[remote rejected]` (a hook,
      // a protected branch) is a failed push with git's reason.
      if (/\[rejected\]|non-fast-forward|fetch first/.test(out)) return 'rejected';
      throw new HttpError(409, 'push_failed', `Push failed: ${shortGitError(error)}`);
    }
  }
}

/**
 * What `git push --set-upstream origin` writes, when the branch has no upstream yet (runner git, no
 * network). The caller holds the main-workspace lock.
 */
export async function setUpstream(mainPath: string, branch: string): Promise<void> {
  const current = await execGitFile(['config', '--get', `branch.${branch}.remote`], { cwd: mainPath }).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (current) return;
  await execGitFile(['config', `branch.${branch}.remote`, 'origin'], { cwd: mainPath });
  await execGitFile(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd: mainPath });
}

/** Adds origin or points it at `url`, and always drops a separate push URL (pushes go where status reads). */
export async function setOrigin(mainPath: string, url: string, current: string | null): Promise<void> {
  if (current !== url) {
    await execGitFile(
      current ? ['remote', 'set-url', '--', 'origin', url] : ['remote', 'add', '--', 'origin', url],
      { cwd: mainPath },
    );
  }
  await execGitFile(['config', '--unset-all', 'remote.origin.pushurl'], { cwd: mainPath }).catch(
    () => undefined,
  );
}
