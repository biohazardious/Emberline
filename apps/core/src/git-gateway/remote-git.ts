/**
 * Emberline's own git with a forge account, run by the runner's hardened git (no credentials)
 * against a capability URL of the gateway. The capability URL is only the explicit URL argument of
 * that one command (for the import clone, a command-scope `insteadOf` for the real URL); nothing is
 * written to `.git/config`; submodules are never recursed into; only the gateway's scheme is
 * allowed; no redirect, proxy or credential helper applies.
 */
import { isRunnerUnavailable } from '../command-exec.js';
import { withMainWorkspaceLock } from '../factory/merge.js';
import { execGitFile, HARDENED_GIT_ARGS, NO_SUBMODULES } from '../git-exec.js';
import type { GitHttpCredential } from '../git-credentials.js';
import { CAPABILITY_ROUTE_PREFIX, type GitGateway } from './gateway.js';
import { oldValueRefusal } from './receive-pack.js';
import { GitGatewayError } from './upstream.js';

const MINUTE = 60_000;

export interface AccountRemote {
  gateway: GitGateway;
  projectId: string;
  /** projects.repoUrl, the URL being connected or imported: never a URL from .git/config. */
  url: string;
  credential: GitHttpCredential;
}

export function gatewayGitArgs(gateway: GitGateway): string[] {
  const scheme = new URL(gateway.baseUrl).protocol.replace(':', '');
  return [
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    `protocol.${scheme}.allow=always`,
    '-c',
    'http.followRedirects=false',
    '-c',
    'http.proxy=',
    '-c',
    'credential.helper=',
    ...NO_SUBMODULES,
  ];
}

const grant = (r: AccountRemote, extra: Partial<Parameters<GitGateway['issue']>[0]> = {}) => ({
  projectId: r.projectId,
  upstreamUrl: r.url,
  credential: r.credential,
  service: 'git-upload-pack' as const,
  ...extra,
});

/** The remote's branches with their commits (`ls-remote --heads`). */
async function remoteHeads(
  r: AccountRemote,
  cwd: string,
  branch?: string,
): Promise<{ name: string; oid: string }[]> {
  // ls-remote never recurses into submodules (it has no such option).
  const out = await r.gateway.run(
    grant(r),
    async (url) =>
      (
        await execGitFile(
          [
            ...gatewayGitArgs(r.gateway),
            'ls-remote',
            '--heads',
            '--',
            url,
            ...(branch ? [`refs/heads/${branch}`] : []),
          ],
          { cwd, timeout: MINUTE },
        )
      ).stdout,
  );
  return out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([oid, ref]) => oid && ref?.trim().startsWith('refs/heads/'))
    .map(([oid, ref]) => ({ name: ref!.trim().slice('refs/heads/'.length), oid: oid!.trim() }));
}

export async function accountRemoteBranches(
  r: AccountRemote,
  cwd: string,
  branch?: string,
): Promise<string[]> {
  return (await remoteHeads(r, cwd, branch)).map((head) => head.name);
}

/** The commit the remote's branch names now, or null when the remote has no such branch. */
export async function accountRemoteHead(
  r: AccountRemote,
  cwd: string,
  branch: string,
): Promise<string | null> {
  return (await remoteHeads(r, cwd, branch)).find((head) => head.name === branch)?.oid ?? null;
}

/**
 * Git for the push plan reads only the real objects: no replace refs, no `info/grafts`, no
 * commit-graph. Agents can write all three in the shared repository to fake ancestry.
 */
const PLAN_ENV = { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
const planGit = (args: string[], cwd: string) =>
  execGitFile(['-c', 'core.commitGraph=false', '-c', 'core.useReplaceRefs=false', ...args], {
    cwd,
    env: PLAN_ENV,
  });

/** Whether `cwd`'s object store has the commit (the runner's git, no network). */
async function hasCommit(cwd: string, oid: string): Promise<boolean> {
  return planGit(['cat-file', '-e', `${oid}^{commit}`], cwd).then(
    () => true,
    (error: unknown) => {
      if (isRunnerUnavailable(error)) throw error; // not "missing": the runner could not look
      return false;
    },
  );
}

/**
 * Fetches a remote branch's objects without updating any ref (no destination, `--refmap=`, no
 * FETCH_HEAD, no commit-graph, no auto maintenance).
 */
export async function accountFetchBranchObjects(
  r: AccountRemote,
  repoPath: string,
  branch: string,
): Promise<void> {
  await r.gateway.run(grant(r), (url) =>
    execGitFile(
      [
        ...gatewayGitArgs(r.gateway),
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
        url,
        `refs/heads/${branch}`,
      ],
      { cwd: repoPath, timeout: 10 * MINUTE, env: PLAN_ENV },
    ),
  );
}

/** Exit code 1 of `merge-base --is-ancestor` is "no"; anything else is a failure. */
async function isAncestor(cwd: string, ancestor: string, commit: string): Promise<boolean> {
  try {
    await planGit(['merge-base', '--is-ancestor', ancestor, commit], cwd);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/** The forge's own reason for refusing (a hook, a protected branch): its first `remote:` line, else git's. */
function forgeRefusal(out: string): string | null {
  const porcelain = /^!\t\S+\t\[remote (?:rejected|failure)\] \((.*)\)$/m.exec(out);
  if (!porcelain) return null;
  const remote = out
    .split('\n')
    .map((line) => /^remote: (?:error: )?(.*)$/.exec(line.trim())?.[1]?.trim() ?? '')
    .find(Boolean);
  return remote || porcelain[1]!;
}

/**
 * Pushes `oid` (default: the commit refs/heads/<branch> names now) to that ref, only as a
 * fast-forward, never with tags:
 * - the remote branch's commit is read first (ls-remote through the gateway), fetched if missing;
 * - a branch that is not a descendant of it is `'rejected'` before any push;
 * - the push capability is bound to that old commit and the new one, so the forge updates the ref
 *   only if it still holds what was checked (no force, whatever the runner's git sends).
 */
export async function accountPushBranch(
  r: AccountRemote,
  repoPath: string,
  branch: string,
  oid?: string,
): Promise<'pushed' | 'rejected'> {
  const ref = `refs/heads/${branch}`;
  // A shallow repository's history is cut off (`.git/shallow`): it cannot show a fast-forward.
  if ((await planGit(['rev-parse', '--is-shallow-repository'], repoPath)).stdout.trim() !== 'false') {
    throw new GitGatewayError(
      'git_failed',
      'Emberline pushes with the forge account only from a complete clone; this repository is shallow.',
    );
  }
  const newOid = (
    await planGit(['rev-parse', '--verify', '--quiet', `${oid ?? ref}^{commit}`], repoPath)
  ).stdout.trim();
  const remoteOid = await accountRemoteHead(r, repoPath, branch);
  if (remoteOid === newOid) return 'pushed';
  if (remoteOid) {
    if (!(await hasCommit(repoPath, remoteOid))) await accountFetchBranchObjects(r, repoPath, branch);
    // Still missing: the remote moved on since; not a fast-forward of what was checked.
    if (!(await hasCommit(repoPath, remoteOid)) || !(await isAncestor(repoPath, remoteOid, newOid)))
      return 'rejected';
  }
  const plan = { ref, newOid, oldOid: remoteOid ?? '0'.repeat(newOid.length) };
  try {
    return await r.gateway.run(grant(r, { service: 'git-receive-pack', push: plan }), async (url) => {
      try {
        await execGitFile(
          [
            ...gatewayGitArgs(r.gateway),
            'push',
            '--porcelain',
            '--no-recurse-submodules',
            '--no-follow-tags',
            '--',
            url,
            `${newOid}:${ref}`,
          ],
          { cwd: repoPath, timeout: 10 * MINUTE },
        );
        return 'pushed' as const;
      } catch (error) {
        const out = `${String((error as { stdout?: unknown }).stdout ?? '')}\n${String((error as { stderr?: unknown }).stderr ?? '')}`;
        const refusal = forgeRefusal(out);
        if (refusal) throw new GitGatewayError('git_failed', `The forge refused the push: ${refusal}`);
        if (/\[rejected\]|non-fast-forward|fetch first/.test(out)) return 'rejected' as const;
        throw error;
      }
    });
  } catch (error) {
    // The remote moved between the check and the push: the same answer as a remote that is ahead.
    if (
      error instanceof GitGatewayError &&
      error.code === 'ref_refused' &&
      error.message === oldValueRefusal(plan)
    )
      return 'rejected';
    throw error;
  }
}

/**
 * The import clone's PTY command: a capability for 60 minutes (first use within 2), tracked until
 * import-status sees the clone end. git clones the real URL, which a command-scope `insteadOf`
 * points at the capability URL: `.git/config` gets the real URL as origin, never the capability.
 * `branch`: the one to check out; the remote's default branch without it.
 */
export function accountCloneArgs(r: AccountRemote, target: string, branch: string | null = null): string[] {
  const { capability, url } = r.gateway.issue(grant(r, { firstUseMs: 2 * MINUTE, operationMs: 60 * MINUTE }));
  r.gateway.trackClone(r.projectId, capability);
  return [
    // The clone runs in a ptyd terminal, not through execGitFile, so it carries the hardening args
    // itself (hooks, askpass, ssh, fsmonitor), and {@link cloneGitEnv} carries the hardened env.
    ...HARDENED_GIT_ARGS,
    ...gatewayGitArgs(r.gateway),
    '-c',
    `url.${url}.insteadOf=${r.url}`,
    'clone',
    '--progress',
    '--no-recurse-submodules',
    ...(branch ? ['--branch', branch] : []),
    '--',
    r.url,
    target,
  ];
}

/**
 * The clone ended: release its capability (if this core still tracks it) and, whenever origin still
 * names a gateway URL (an older clone, a restart), point it at the real URL; a failed repair throws
 * and the next poll tries again. Returns why the gateway refused, if it did.
 */
export async function finishAccountClone(
  gateway: GitGateway,
  project: { id: string; path: string; repoUrl: string | null },
  cloned: boolean,
): Promise<string | null> {
  const ended = gateway.endClone(project.id);
  const repoUrl = project.repoUrl;
  if (cloned && repoUrl) {
    await withMainWorkspaceLock(project.path, async () => {
      const origin = await execGitFile(['-C', project.path, 'remote', 'get-url', 'origin']).then(
        (res) => res.stdout.trim(),
        () => '',
      );
      if (origin.includes(CAPABILITY_ROUTE_PREFIX)) {
        await execGitFile(['-C', project.path, 'remote', 'set-url', '--', 'origin', repoUrl]);
      }
    });
  }
  return ended?.outcome?.message ?? null;
}
