import { badRequest, HttpError } from '../errors.js';
import { parseForgeRemote } from '../forge/service.js';
import { execGitFile } from '../git-exec.js';
import { describeGitError } from '../git-gateway/gateway.js';
import {
  type AccountRemote,
  accountFetchBranch,
  accountPushBranch,
  accountRemoteBranches,
} from '../git-gateway/remote-git.js';

export const DIVERGED_MESSAGE =
  "The remote's main has commits this project doesn't have. Pull them in from a terminal, then push again.";
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

/** A forge remote (https, http, ssh, scp-like) Emberline may store as origin. */
export function validateRepositoryUrl(raw: string): {
  url: string;
  host: string;
  transport: 'https' | 'http' | 'ssh';
} {
  const url = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!url || url.startsWith('-') || /[\s\u0000-\u001f]/.test(url) || url.includes('::'))
    throw badRequest(BAD_URL);
  let transport: 'https' | 'http' | 'ssh';
  if (/^https?:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest(BAD_URL);
    }
    if (parsed.username || parsed.password)
      throw badRequest('Remove the user name and token from the URL; Emberline uses the forge account.');
    transport = parsed.protocol === 'http:' ? 'http' : 'https';
  } else if (/^ssh:\/\//i.test(url) || /^[^/:]+@?[^/:]*:[^/]/.test(url)) {
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

/** Updates only `refs/remotes/origin/<branch>`: an explicit refspec and `--refmap=` on both paths. */
export async function fetchBranch(mainPath: string, access: RemoteAccess, branch: string): Promise<void> {
  if (access.account) {
    await accountFetchBranch(access.account, mainPath, branch);
    return;
  }
  await execGitFile(
    [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--no-recurse-submodules',
      '--refmap=',
      '--',
      access.url,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    { cwd: mainPath, timeout: 30_000 },
  );
}

export async function aheadBehind(
  mainPath: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  const out = (
    await execGitFile(
      ['rev-list', '--left-right', '--count', `refs/heads/${branch}...refs/remotes/origin/${branch}`],
      { cwd: mainPath },
    )
  ).stdout;
  const [ahead, behind] = out.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

/** Pushes `refs/heads/<branch>` to the same name at the access URL: never forced; the first push sets upstream. */
export async function pushBranch(
  mainPath: string,
  access: RemoteAccess,
  branch: string,
): Promise<'pushed' | 'rejected'> {
  const ref = `refs/heads/${branch}`;
  let result: 'pushed' | 'rejected';
  if (access.account) {
    try {
      result = await accountPushBranch(access.account, mainPath, branch);
    } catch (error) {
      throw new HttpError(
        409,
        'push_failed',
        `Push failed: ${describeGitError(error, access.account.credential)}`,
      );
    }
  } else {
    // The commit the branch names now (the caller holds the main-workspace lock), pushed to the same ref.
    const oid = (
      await execGitFile(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: mainPath })
    ).stdout.trim();
    try {
      await execGitFile(
        ['push', '--porcelain', '--no-recurse-submodules', '--', access.url, `${oid}:${ref}`],
        { cwd: mainPath, timeout: 60_000 },
      );
      result = 'pushed';
    } catch (error) {
      const out = `${String((error as { stdout?: unknown }).stdout ?? '')}\n${String((error as { stderr?: unknown }).stderr ?? '')}`;
      if (/^!\s/m.test(out) || /\[rejected\]|Updates were rejected|non-fast-forward|fetch first/.test(out))
        return 'rejected';
      throw new HttpError(409, 'push_failed', `Push failed: ${shortGitError(error)}`);
    }
  }
  if (result === 'pushed') await setUpstream(mainPath, branch);
  return result;
}

/** What `git push --set-upstream origin` writes, when the branch has no upstream yet (runner git, no network). */
async function setUpstream(mainPath: string, branch: string): Promise<void> {
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
