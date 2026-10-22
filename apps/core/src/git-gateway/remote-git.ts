/**
 * Emberline's own git with a forge account, run by the runner's hardened git (no credentials)
 * against a capability URL of the gateway. The capability URL is only the explicit URL argument of
 * that one command; nothing is written to `.git/config`; submodules are never recursed into; only
 * the gateway's scheme is allowed; no redirect, proxy or credential helper applies.
 */
import { execGitFile } from '../git-exec.js';
import type { GitHttpCredential } from '../git-credentials.js';
import type { GitGateway } from './gateway.js';

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
    `protocol.${scheme}.allow=always`,
    '-c',
    'http.followRedirects=false',
    '-c',
    'http.proxy=',
    '-c',
    'credential.helper=',
  ];
}

const grant = (r: AccountRemote, extra: Partial<Parameters<GitGateway['issue']>[0]> = {}) => ({
  projectId: r.projectId,
  upstreamUrl: r.url,
  credential: r.credential,
  service: 'git-upload-pack' as const,
  ...extra,
});

export async function accountRemoteBranches(
  r: AccountRemote,
  cwd: string,
  branch?: string,
): Promise<string[]> {
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
    .map((line) => line.split('\t')[1]?.trim() ?? '')
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
}

/** Updates only refs/remotes/origin/<branch> (explicit refspec, `--refmap=`). */
export async function accountFetchBranch(r: AccountRemote, repoPath: string, branch: string): Promise<void> {
  await r.gateway.run(grant(r), (url) =>
    execGitFile(
      [
        ...gatewayGitArgs(r.gateway),
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--refmap=',
        '--',
        url,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { cwd: repoPath, timeout: 10 * MINUTE },
    ),
  );
}

/** Pushes the commit refs/heads/<branch> names now, to the same ref: never forced; the gateway lets only that ref and that commit through. */
export async function accountPushBranch(
  r: AccountRemote,
  repoPath: string,
  branch: string,
): Promise<'pushed' | 'rejected'> {
  const ref = `refs/heads/${branch}`;
  const newOid = (
    await execGitFile(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath })
  ).stdout.trim();
  return r.gateway.run(grant(r, { service: 'git-receive-pack', push: { ref, newOid } }), async (url) => {
    try {
      await execGitFile(
        [
          ...gatewayGitArgs(r.gateway),
          'push',
          '--porcelain',
          '--no-recurse-submodules',
          '--',
          url,
          `${newOid}:${ref}`,
        ],
        { cwd: repoPath, timeout: 10 * MINUTE },
      );
      return 'pushed' as const;
    } catch (error) {
      const out = `${String((error as { stdout?: unknown }).stdout ?? '')}\n${String((error as { stderr?: unknown }).stderr ?? '')}`;
      if (/^!\s/m.test(out) || /\[rejected\]|non-fast-forward|fetch first/.test(out))
        return 'rejected' as const;
      throw error;
    }
  });
}

/** The import clone's PTY command: a capability for 60 minutes (first use within 2), tracked until import-status sees the clone end. */
export function accountCloneArgs(r: AccountRemote, target: string): string[] {
  const { capability, url } = r.gateway.issue(grant(r, { firstUseMs: 2 * MINUTE, operationMs: 60 * MINUTE }));
  r.gateway.trackClone(r.projectId, capability);
  return [...gatewayGitArgs(r.gateway), 'clone', '--progress', '--no-recurse-submodules', '--', url, target];
}

/** The clone ended: release the capability, and (once) point origin at the real URL. Returns why the gateway refused, if it did. */
export async function finishAccountClone(
  gateway: GitGateway,
  project: { id: string; path: string; repoUrl: string | null },
  cloned: boolean,
): Promise<string | null> {
  const ended = gateway.endClone(project.id);
  if (!ended) return null;
  if (ended.first && cloned && project.repoUrl) {
    await execGitFile(['-C', project.path, 'remote', 'set-url', '--', 'origin', project.repoUrl]);
  }
  return ended.outcome?.message ?? null;
}
