import { isRunnerUnavailable } from '../command-exec.js';
import { badRequest, conflict, HttpError } from '../errors.js';
import { remoteUrlForDisplay, scpUserInfoBeforePath } from '../forge/hosts.js';
import { parseForgeRemote } from '../forge/service.js';
import { execGitFile, NO_SUBMODULES } from '../git-exec.js';
import { describeGitError, type KnownSecrets } from '../git-gateway/gateway.js';
import { GitGatewayError } from '../git-gateway/upstream.js';
import {
  type GatewayRemote,
  gatewayHttpCredential,
  gatewayFetchBranchObjects,
  gatewayPushBranch,
  gatewayPushRef,
  gatewayRemoteBranches,
  gatewayRemoteRef,
  refKind,
} from '../git-gateway/remote-git.js';

export const MAIN_MOVED_MESSAGE =
  "Main's latest commit is not this merge, so Keep main pushed did not push it. Check main, then push it from Project settings → Repository.";
export const MERGE_UNVERIFIED_MESSAGE =
  'Main changed during the merge; Emberline did not record it for pushing.';
export const ORIGIN_CHANGED_MESSAGE =
  "This project's repository changed after the merge, so Keep main pushed did not push it. Push main from Project settings → Repository.";
export const RUNNER_WAITING_MESSAGE = 'Waiting for the runner; main is pushed when it answers.';
export const DIVERGED_MESSAGE =
  "The remote's main has commits this project doesn't have. Pull them in from a terminal, then push again.";
/** An integration branch someone else pushed to: Emberline fast-forwards its own branch and never forces it. */
export const integrationDivergedMessage = (branch: string) =>
  `The remote's ${branch} has commits this project's main doesn't have (someone pushed to it). Emberline never forces it: merge ${branch} into main on the forge or delete it there, then push again.`;
/** The working branch moved on after the merge (not to a later Emberline merge): nothing is pushed. */
export const workingMovedMessage = (branch: string) =>
  `${branch}'s latest commit is not this merge, so Keep pushed did not push it. Check ${branch}, then push it from a terminal.`;
/** Someone pushed to origin's working branch: Emberline fast-forwards it and never forces it. */
export const workingDivergedMessage = (branch: string) =>
  `The remote's ${branch} has commits this project's ${branch} doesn't have. Emberline never forces it: pull them in, then the next merge pushes it again.`;
const CREDENTIALS_IN_URL = 'Remove the user name and token from the URL; Emberline uses the forge account.';
const BAD_URL =
  'Enter a repository URL such as https://github.com/you/app.git or git@github.com:you/app.git.';

/**
 * How origin is reached. Through core's git gateway (`remote`): an http(s) URL under a forge
 * account's server, with that account, or an ssh address, with the project's chosen SSH key; the
 * token or key never leaves core. Otherwise (a public http(s) remote) git goes straight to the URL.
 */
export interface RemoteAccess {
  /**
   * projects.repoUrl, or the URL being connected. Without the gateway it may be origin as configured,
   * with a token typed into it, but only when that names the same repository as projects.repoUrl.
   */
  url: string;
  remote: GatewayRemote | null;
}

/** What core knows is secret around a git command to this remote (the account's token, the URL's password). */
export const accessSecrets = (
  access: RemoteAccess,
  addresses: readonly string[] = [access.url],
): KnownSecrets => ({
  credential: gatewayHttpCredential(access.remote),
  addresses,
});

/**
 * An ssh setup failure the person fixes in Emberline (no key, a host key to trust, a changed host
 * key), as the API error with the gateway's code and, for a host key, the key the server offered.
 * Null for any other failure.
 */
export function sshSetupError(error: unknown, prefix = ''): HttpError | null {
  if (!(error instanceof GitGatewayError)) return null;
  if (!['ssh_key_missing', 'host_key_unknown', 'host_key_changed'].includes(error.code)) return null;
  return new HttpError(
    409,
    error.code,
    `${prefix}${error.message}`,
    error.hostKey ? { hostKey: error.hostKey } : undefined,
  );
}

/**
 * The first useful line of a failed gateway or git call (no secret core knows, no token, no
 * capability), at most 300 characters.
 */
export function shortGitError(error: unknown, known?: KnownSecrets): string {
  return describeGitError(error, known);
}

export { remoteUrlForDisplay };

export const REMOTE_NOT_SUPPORTED =
  'Emberline reaches a repository only over https, http, ssh or an scp-style host:path address (such as git@host:owner/repo.git). Change origin in Project settings → Repository; a local path or a file:// or git:// address is not allowed.';

/**
 * Whether git would reach `raw` over a transport Emberline allows: https, http, ssh or an scp-like
 * `host:path`. A local path, `file://`, `git://`, `ext::` or any other transport is not, because
 * git runs that other repository's own hooks and helpers (its `-c` overrides do not cross into
 * another repository), and `ext::`/`git://` are unsafe outright. The credential may still be refused
 * elsewhere; this is only about the transport.
 */
export function isSupportedRemoteUrl(raw: string): boolean {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url) || /^ssh:\/\//i.test(url)) return true;
  // Any other `scheme://`, and the remote-helper `transport::address` form (ext::, fd::).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[a-z0-9+.-]+::/i.test(url)) return false;
  // scp-like: a colon before the first slash (`git@host:o/r`, `host:o/r`), never a local path.
  const slash = url.indexOf('/');
  const colon = url.indexOf(':');
  return colon > 0 && (slash < 0 || colon < slash);
}

/** Refuses origin whose transport Emberline does not reach (a local path, `file://`, `ext::`, …). */
export function assertSupportedRemote(raw: string): void {
  if (!isSupportedRemoteUrl(raw)) throw conflict(REMOTE_NOT_SUPPORTED, 'remote_not_supported');
}

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
    // The parser ends the user info and host at a `\`; git sends it as part of the user info
    // (`https://u:2024\S3CRET@host/…`), so it may hold a password.
    const backslash = url.indexOf('\\');
    if (backslash >= 0) throw badRequest(url.indexOf('@', backslash) > 0 ? CREDENTIALS_IN_URL : BAD_URL);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest(BAD_URL);
    }
    // Only user info git would send: `https://u:2024/rest@host/…` reads as the port 2024 and a path,
    // as `https://host:8443/g/n@v2/r.git` does (the display masks both).
    if (parsed.username || parsed.password) throw badRequest(CREDENTIALS_IN_URL);
    // A query or fragment can carry a token (`?private_token=`) and is no part of a repository's address.
    if (parsed.search || parsed.hash) throw badRequest(BAD_URL);
    transport = parsed.protocol === 'http:' ? 'http' : 'https';
  } else if (/^ssh:\/\//.test(url) || /^[^/:]+@?[^/:]*:[^/]/.test(url)) {
    // A password in an ssh URL (`ssh://user:pw@host`, `user:pw@host:path`) is a credential too. An
    // ssh URL is read as git and the display read it: its user info runs to the last `@` before the
    // path (`ssh://me@corp.com:pw@host` has the password `pw`), and one that does not parse is
    // refused (`ssh://git:pa/ss@host` as holding credentials). An scp-like address may hold one
    // when a `user:…@` comes before its first `/` (`host:a@x/y` too, which it cannot tell from
    // `user:token@host/path`); an `@` after the first `/` is a path's (`gitea:team/app@v2/x.git`).
    if (url.startsWith('ssh://')) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        // Unparseable: a `:` before its last `@` may be a password's.
        const at = url.lastIndexOf('@');
        throw badRequest(at > 0 && url.slice(6, at).includes(':') ? CREDENTIALS_IN_URL : BAD_URL);
      }
      if (parsed.password) throw badRequest(CREDENTIALS_IN_URL);
    } else if (scpUserInfoBeforePath(url)) throw badRequest(CREDENTIALS_IN_URL);
    transport = 'ssh';
  } else {
    throw badRequest(BAD_URL);
  }
  const remote = parseForgeRemote(url);
  if (!remote || remote.host.startsWith('-')) throw badRequest(BAD_URL);
  return { url, host: remote.host, transport };
}

export const PASSWORD_GIT_WOULD_SHOW =
  "Remove the password from the address: git can't use it there and would show it in the clone's output. Use an ssh key, or add a forge account for this server in Settings.";

/**
 * Whether git, cloning this address, would print its password where a person sees the clone's
 * output: an ssh URL's `user:password@host` goes to ssh as the login (ssh prints it, and never uses
 * the password), an scp-like `user:…@` before the path splits so that the password starts the path
 * git quotes, and an http(s) `\` before an `@` (the parser and git read the user info differently).
 * An http(s) address's user name and password otherwise go only into git's Authorization header:
 * git leaves them out of every address it prints.
 */
export function passwordGitWouldShow(raw: string): boolean {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url)) {
    const backslash = url.indexOf('\\');
    return backslash >= 0 && url.indexOf('@', backslash) > 0;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      return Boolean(new URL(url).password);
    } catch {
      const at = url.lastIndexOf('@');
      return at > 0 && url.slice(url.indexOf('://') + 3, at).includes(':');
    }
  }
  return scpUserInfoBeforePath(url);
}

/** A failed git command reads as `fallback`; a runner that could not run it is thrown, never read as an answer. */
export const unlessRunnerUnavailable =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if (isRunnerUnavailable(error)) throw error;
    return fallback;
  };

export async function mainBranchState(
  mainPath: string,
): Promise<{ branch: string | null; hasCommits: boolean }> {
  const ref = await execGitFile(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: mainPath }).catch(
    unlessRunnerUnavailable({ stdout: '' }),
  );
  const head = await execGitFile(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: mainPath }).catch(
    unlessRunnerUnavailable({ stdout: '' }),
  );
  return { branch: ref.stdout.trim() || null, hasCommits: Boolean(head.stdout.trim()) };
}

/**
 * Git that reads only the real objects: no replace refs, no `info/grafts`, no commit-graph (agents
 * can write all three in the shared repository to make a commit look like another).
 */
const REAL_OBJECTS_ENV = { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
export const realGit = (args: string[], cwd: string) =>
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
  ).then((r) => r.stdout.trim(), unlessRunnerUnavailable(''));
  const [sha, shortSha, subject] = out.split('\0');
  return sha && shortSha ? { sha, shortSha, subject: subject ?? '' } : null;
}

/** Whether `ancestor` is `commit` or one of its ancestors, in the real objects; any failure is "no". */
export async function isAncestorCommit(mainPath: string, ancestor: string, commit: string): Promise<boolean> {
  return realGit(['merge-base', '--is-ancestor', ancestor, commit], mainPath).then(
    () => true,
    unlessRunnerUnavailable(false),
  );
}

export async function originUrls(mainPath: string): Promise<{ fetch: string | null; push: string | null }> {
  const read = async (args: string[]) =>
    (
      await execGitFile(args, { cwd: mainPath }).catch(unlessRunnerUnavailable({ stdout: '' }))
    ).stdout.trim() || null;
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
  if (!access.remote) assertSupportedRemote(access.url);
  const names = access.remote
    ? await gatewayRemoteBranches(access.remote, mainPath, branch)
    : (
        await execGitFile(
          [
            ...NO_SUBMODULES,
            'ls-remote',
            '--heads',
            '--',
            access.url,
            ...(branch ? [`refs/heads/${branch}`] : []),
          ],
          { cwd: mainPath, timeout: 20_000, remote: true },
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
  return remoteRefHead(mainPath, access, `refs/heads/${branch}`);
}

const refNotPushable = (ref: string) =>
  badRequest(
    `Emberline pushes and reads only a branch or a tag on origin, not ${JSON.stringify(ref.slice(0, 100))}.`,
  );

/**
 * What exactly `ref` (`refs/heads/<branch>` or `refs/tags/<tag>`) names on the remote: a commit, or an
 * annotated tag's own object; null when the remote has no such ref.
 */
export async function remoteRefHead(
  mainPath: string,
  access: RemoteAccess,
  ref: string,
): Promise<string | null> {
  if (!refKind(ref)) throw refNotPushable(ref);
  if (access.remote) return gatewayRemoteRef(access.remote, mainPath, ref);
  assertSupportedRemote(access.url);
  const out = (
    await execGitFile([...NO_SUBMODULES, 'ls-remote', '--', access.url, ref], {
      cwd: mainPath,
      timeout: 20_000,
      remote: true,
    })
  ).stdout;
  // Only the exact ref: ls-remote matches a pattern by its tail and adds a tag's peeled `^{}` line.
  for (const line of out.split('\n')) {
    const [oid, name] = line.split('\t');
    if (name?.trim() === ref && OID.test(oid?.trim() ?? '')) return oid!.trim();
  }
  return null;
}

const hasRealCommit = (cwd: string, oid: string) =>
  realGit(['cat-file', '-e', `${oid}^{commit}`], cwd).then(() => true, unlessRunnerUnavailable(false));

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
  if (access.remote) await gatewayFetchBranchObjects(access.remote, mainPath, branch);
  else {
    assertSupportedRemote(access.url);
    // Only the real objects, as on the gateway path: no replace refs, grafts or commit-graph.
    await execGitFile(
      [
        ...NO_SUBMODULES,
        '-c',
        'core.commitGraph=false',
        '-c',
        'core.useReplaceRefs=false',
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
      { cwd: mainPath, timeout: 30_000, env: REAL_OBJECTS_ENV, remote: true },
    );
  }
  // The remote moved on between ls-remote and the fetch.
  if (!(await hasRealCommit(mainPath, oid)))
    throw new HttpError(
      409,
      'remote_moved',
      "origin's main changed while Emberline read it. Press Refresh again.",
    );
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
  if (!access.remote) assertSupportedRemote(access.url);
  try {
    if (access.remote) return await gatewayPushBranch(access.remote, mainPath, branch, oid);
    await execGitFile(
      [
        ...NO_SUBMODULES,
        'push',
        '--porcelain',
        '--no-recurse-submodules',
        '--no-follow-tags',
        '--',
        access.url,
        `${oid}:${ref}`,
      ],
      { cwd: mainPath, timeout: 60_000, remote: true },
    );
    return 'pushed';
  } catch (error) {
    return pushFailure(error, access);
  }
}

/**
 * A push that failed: `'rejected'` when git says origin's ref is not what this push expects (a
 * non-fast-forward, a lease that no longer holds, a tag origin has), else the API error with git's
 * reason. Through the gateway, the remote-moved answers are `'rejected'` already ({@link gatewayPushRef}),
 * so what reaches here is a failed push (an ssh setup error keeps its own code). A runner that could not
 * run git is thrown as it is: that is no failed push.
 */
function pushFailure(error: unknown, access: RemoteAccess): 'rejected' {
  if (isRunnerUnavailable(error) || error instanceof HttpError) throw error;
  const known = accessSecrets(access);
  if (access.remote) {
    throw (
      sshSetupError(error, 'Push failed: ') ??
      new HttpError(409, 'push_failed', `Push failed: ${shortGitError(error, known)}`)
    );
  }
  const out = `${String((error as { stdout?: unknown }).stdout ?? '')}\n${String((error as { stderr?: unknown }).stderr ?? '')}`;
  // Only a `[rejected]` (also a stale lease, a tag origin has) or a non-fast-forward is "origin is not
  // what this push expects"; a `[remote rejected]` (a hook, a protected branch) is a failed push with
  // git's reason.
  if (/\[rejected\]|non-fast-forward|fetch first/.test(out)) return 'rejected';
  throw new HttpError(409, 'push_failed', `Push failed: ${shortGitError(error, known)}`);
}

/**
 * Pushes one ref change other than a branch update ({@link pushBranch} does those), never forced:
 * - a new tag (`refs/tags/<t>`, `expectOld: null`): `'rejected'` when origin has that tag already,
 *   whatever it names; Emberline never moves a tag. The push is a create, so a racing creator wins and
 *   this one is refused.
 * - a branch delete the person asked for (`refs/heads/<b>`, `newOid: null`): only while origin's
 *   branch still names `expectOld` (a compare-and-delete), else `'rejected'`.
 * Writes nothing locally; anything else is a 400 before origin is reached.
 */
export async function pushRef(
  mainPath: string,
  access: RemoteAccess,
  push: { ref: string; newOid: string | null; expectOld: string | null },
): Promise<'pushed' | 'rejected'> {
  const { ref, newOid, expectOld } = push;
  const kind = refKind(ref);
  if (!kind) throw refNotPushable(ref);
  if (newOid !== null && !OID.test(newOid)) throw badRequest('A push names the new object by its full id.');
  if (expectOld !== null && !OID.test(expectOld))
    throw badRequest('A push names the expected object by its full id.');
  const tag = kind === 'tag' && newOid !== null && expectOld === null;
  const remove = kind === 'branch' && newOid === null && expectOld !== null;
  if (!tag && !remove) {
    throw badRequest(
      kind === 'tag'
        ? 'Emberline only creates a tag on origin; it never moves or deletes one.'
        : 'Emberline deletes a branch on origin only from the commit it expects there; it updates a branch only as a fast-forward push.',
    );
  }
  if (tag) {
    // A release tag is annotated (a tag object), a lightweight one names a commit; nothing else is pushed.
    const type = await realGit(['cat-file', '-t', newOid!], mainPath).then(
      (r) => r.stdout.trim(),
      unlessRunnerUnavailable(''),
    );
    if (type !== 'tag' && type !== 'commit')
      throw badRequest(`${ref} names no tag or commit in this project's repository.`);
  }
  if (!access.remote) assertSupportedRemote(access.url);
  try {
    // A tag origin has, or a branch that moved or is gone: nothing to push, whatever git would do.
    const current = await remoteRefHead(mainPath, access, ref);
    if (tag ? current !== null : current !== expectOld) return 'rejected';
    if (access.remote) {
      return await gatewayPushRef(
        access.remote,
        mainPath,
        tag
          ? { ref, newOid: newOid!, oldOid: '0'.repeat(newOid!.length) }
          : { ref, newOid: '0'.repeat(expectOld!.length), oldOid: expectOld!, allowDelete: true },
      );
    }
    await execGitFile(
      [
        ...NO_SUBMODULES,
        'push',
        '--porcelain',
        '--no-recurse-submodules',
        '--no-follow-tags',
        // The only lease Emberline uses: the delete applies only while origin's branch is `expectOld`.
        // It is a compare-and-delete, not a force; a delete is no fast-forward either way.
        ...(remove ? [`--force-with-lease=${ref}:${expectOld}`] : []),
        '--',
        access.url,
        remove ? `:${ref}` : `${newOid}:${ref}`,
      ],
      { cwd: mainPath, timeout: 60_000, remote: true },
    );
    return 'pushed';
  } catch (error) {
    return pushFailure(error, access);
  }
}

/**
 * What `git push --set-upstream origin` writes, when the branch has no upstream yet (runner git, no
 * network). The caller holds the main-workspace lock.
 */
export async function setUpstream(mainPath: string, branch: string): Promise<void> {
  const current = await execGitFile(['config', '--get', `branch.${branch}.remote`], { cwd: mainPath }).then(
    (r) => r.stdout.trim(),
    unlessRunnerUnavailable(''),
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
