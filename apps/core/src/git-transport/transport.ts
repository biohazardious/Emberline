/**
 * Emberline's own git over HTTP with a forge account, in core: isomorphic-git (pinned) over core's
 * HTTP client (http.ts) and the link-safe view of `.git` (repo-fs.ts). No process is started and
 * nothing credential-related is passed to ptyd or the runner. The URL is always Emberline's
 * (projects.repoUrl, or the URL being connected or imported); `.git/config` is never read, so its
 * pushurl, insteadOf, proxy, corsProxy, helpers, askPass and submodules take no effect, and a push
 * is never forced. SHA-1 repositories only (isomorphic-git); shallow ones are refused.
 */
import * as git from 'isomorphic-git';
import { type GitHttpCredential, redactCredential } from '../git-credentials.js';
import { createGitHttp, type GitHttpLimits, GitTransportError } from './http.js';
import { isSafeRefPath, RepoFs } from './repo-fs.js';

const MB = 1024 * 1024;
const MINUTE = 60_000;

export interface TransportTarget {
  url: string;
  credential: GitHttpCredential;
  signal?: AbortSignal;
  limits?: Partial<GitHttpLimits>;
}
export interface RepoTarget extends TransportTarget {
  workspacesDir: string;
  repoRoot: string;
}

function branchRef(branch: string): string {
  const ref = `refs/heads/${branch}`;
  if (!isSafeRefPath(ref))
    throw new GitTransportError(
      'unsupported',
      `"${branch}" is not a branch name Emberline pushes or fetches.`,
    );
  return ref;
}

/** What isomorphic-git sees instead of `.git/config`: one fetch refspec for origin, nothing else. */
function transportConfig(fetchRefspec: string): string {
  return `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\tfetch = ${fetchRefspec}\n`;
}

export function toTransportError(error: unknown, t: TransportTarget): GitTransportError {
  if (error instanceof GitTransportError) return error;
  const url = new URL(t.url);
  const e = error as { code?: unknown; data?: { statusCode?: unknown } };
  // Never the original: isomorphic-git's HttpError carries the server's response body.
  const detail = redactCredential(error instanceof Error ? error.message : String(error), t.credential).slice(
    0,
    200,
  );
  switch (e.code) {
    case 'HttpError': {
      const status = Number(e.data?.statusCode);
      if (status === 401 || status === 403)
        return new GitTransportError(
          'auth_refused',
          `The forge refused the account's token for ${url.host}.`,
        );
      if (status === 404)
        return new GitTransportError(
          'not_found',
          `${url.host} has no repository at ${url.pathname} that this account can see.`,
        );
      return new GitTransportError('http_status', `${url.host} answered HTTP ${status}.`);
    }
    case 'PushRejectedError':
      return new GitTransportError('rejected', 'The remote branch has commits this one does not have.');
    case 'GitPushError':
      return new GitTransportError(
        /non-fast-forward|fetch first|stale info/i.test(detail) ? 'rejected' : 'push_refused',
        `${url.host} refused the push: ${detail}`,
      );
    case 'SmartHttpError':
      return new GitTransportError(
        'protocol',
        `${url.host} did not answer like a git server at ${url.pathname}.`,
      );
    case 'NotFoundError':
      return new GitTransportError('not_found', `Not found: ${detail}`);
    default:
      return new GitTransportError('protocol', `git over HTTP to ${url.host} failed: ${detail}`);
  }
}

export function describeTransportError(error: unknown, credential?: GitHttpCredential | null): string {
  if (error instanceof GitTransportError) return redactCredential(error.message, credential);
  const stderr = (error as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === 'string' && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^(fatal|error|remote): /, '').trim())
      .find(Boolean) ?? 'git failed';
  return redactCredential(line, credential).slice(0, 300);
}

export async function remoteBranches(t: TransportTarget): Promise<string[]> {
  const http = createGitHttp({
    remoteUrl: t.url,
    credential: t.credential,
    signal: t.signal,
    limits: { totalTimeoutMs: 30_000, maxResponseBytes: 16 * MB, ...t.limits },
  });
  try {
    const refs = await git.listServerRefs({
      http,
      url: t.url,
      prefix: 'refs/heads/',
      protocolVersion: 1,
      corsProxy: '',
    });
    return refs.map((r) => r.ref.slice('refs/heads/'.length));
  } catch (error) {
    throw toTransportError(error, t);
  } finally {
    http.close();
  }
}

export async function pushBranchRef(t: RepoTarget & { branch: string }): Promise<'pushed' | 'rejected'> {
  const ref = branchRef(t.branch);
  const tracking = `refs/remotes/origin/${t.branch}`;
  const repo = await RepoFs.open({
    workspacesDir: t.workspacesDir,
    repoRoot: t.repoRoot,
    config: transportConfig(`+${ref}:${tracking}`),
    refs: [tracking],
  });
  await repo.preflight([ref, tracking]);
  const oid = await git.resolveRef({ fs: repo.client, gitdir: repo.gitdir, ref }).catch(() => null);
  repo.assertClean();
  if (!oid) throw new GitTransportError('not_found', `This repository has no branch ${t.branch}.`);
  if (!/^[0-9a-f]{40}$/.test(oid))
    throw new GitTransportError('unsupported', "Emberline's git transport supports SHA-1 repositories only.");
  const http = createGitHttp({
    remoteUrl: t.url,
    credential: t.credential,
    signal: t.signal,
    limits: { totalTimeoutMs: 5 * MINUTE, ...t.limits },
  });
  try {
    await git.push({
      fs: repo.client,
      http,
      gitdir: repo.gitdir,
      ref,
      remoteRef: ref,
      remote: 'origin',
      url: t.url,
      force: false,
      corsProxy: '',
      cache: {},
    });
    repo.assertClean();
    return 'pushed';
  } catch (error) {
    repo.assertClean();
    const mapped = toTransportError(error, t);
    if (mapped.code === 'rejected') return 'rejected';
    throw mapped;
  } finally {
    http.close();
  }
}

export async function fetchBranchRef(t: RepoTarget & { branch: string }): Promise<void> {
  const ref = branchRef(t.branch);
  const tracking = `refs/remotes/origin/${t.branch}`;
  const repo = await RepoFs.open({
    workspacesDir: t.workspacesDir,
    repoRoot: t.repoRoot,
    config: transportConfig(`+${ref}:${tracking}`),
    refs: [tracking],
  });
  await repo.preflight([ref, tracking]);
  const http = createGitHttp({
    remoteUrl: t.url,
    credential: t.credential,
    signal: t.signal,
    limits: { totalTimeoutMs: 5 * MINUTE, ...t.limits },
  });
  try {
    const res = await git.fetch({
      fs: repo.client,
      http,
      gitdir: repo.gitdir,
      url: t.url,
      remote: 'origin',
      ref: t.branch,
      remoteRef: ref,
      singleBranch: true,
      tags: false,
      corsProxy: '',
      cache: {},
    });
    repo.assertClean();
    if (!res.fetchHead)
      throw new GitTransportError(
        'not_found',
        `${new URL(t.url).host} has no branch ${t.branch} (the repository is empty).`,
      );
  } catch (error) {
    repo.assertClean();
    throw toTransportError(error, t);
  } finally {
    http.close();
  }
}

export async function fetchForClone(
  t: RepoTarget & { onMessage?: (line: string) => void },
): Promise<{ defaultBranch: string | null }> {
  const repo = await RepoFs.open({
    workspacesDir: t.workspacesDir,
    repoRoot: t.repoRoot,
    config: transportConfig('+refs/heads/*:refs/remotes/origin/*'),
    refs: [],
    refPrefixes: ['refs/remotes/origin/', 'refs/tags/'],
  });
  await repo.preflight([]);
  const http = createGitHttp({
    remoteUrl: t.url,
    credential: t.credential,
    signal: t.signal,
    limits: { totalTimeoutMs: 30 * MINUTE, ...t.limits },
  });
  try {
    const res = await git.fetch({
      fs: repo.client,
      http,
      gitdir: repo.gitdir,
      url: t.url,
      remote: 'origin',
      remoteRef: 'HEAD',
      singleBranch: false,
      tags: true,
      corsProxy: '',
      cache: {},
      onMessage: t.onMessage,
    });
    repo.assertClean();
    const head = res.defaultBranch?.replace(/^refs\/heads\//, '') ?? null;
    if (head !== null && !isSafeRefPath(`refs/heads/${head}`)) {
      throw new GitTransportError(
        'unsupported',
        `The remote's default branch "${head}" is not a name Emberline checks out.`,
      );
    }
    return { defaultBranch: head };
  } catch (error) {
    repo.assertClean();
    throw toTransportError(error, t);
  } finally {
    http.close();
  }
}
