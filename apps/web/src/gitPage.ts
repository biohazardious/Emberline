import type { BranchRemoteState, GitBranch, GitPageStatus, GitSync } from '@emberline/protocol';

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** How a branch stands against origin, in words. The counts are only used where they are known. */
export function remoteStateText(
  state: BranchRemoteState,
  ahead?: number | null,
  behind?: number | null,
): string {
  switch (state) {
    case 'up_to_date':
      return 'Up to date with origin';
    case 'behind':
      return behind
        ? `${behind} new ${behind === 1 ? 'commit' : 'commits'} on origin`
        : 'New commits on origin';
    case 'ahead':
      return ahead ? `${commits(ahead)} not on origin yet` : 'Commits not on origin yet';
    case 'diverged':
      return 'Origin and Emberline both have new commits';
    case 'rewritten':
      return "Origin's history was rewritten";
    case 'unpublished':
      return 'Not on origin yet';
    case 'unknown':
      return 'Not read yet';
  }
}

/**
 * The banner for the last pull, or null when there is nothing to say. A pull's background heal is
 * stored as `idle` with a message, so an idle sync with a message is shown too. `pulledCount` is
 * the number of commits the pull brought in, when the caller knows it.
 */
export function syncText(sync: GitSync, pulledCount?: number): string | null {
  switch (sync.state) {
    case 'conflict':
      return `Pull stopped: ${sync.files.join(', ') || 'files'} conflict`;
    case 'workspace_dirty':
      return 'Pull waits: the main workspace has uncommitted changes';
    case 'main_unpushed':
      return 'Main has commits origin lacks; push or promote first';
    case 'rewritten':
      return "Origin's history was rewritten. Match origin keeps your old commits under a backup.";
    case 'diverged':
      return sync.message ?? remoteStateText('diverged');
    case 'error':
      return sync.message ?? 'The last pull failed.';
    case 'pulled':
      return pulledCount !== undefined
        ? `Pulled ${commits(pulledCount)}`
        : (sync.message ?? 'Pulled from origin');
    case 'idle':
      return sync.message;
    case 'up_to_date':
    case 'no_remote':
      return null;
  }
}

/** Why a release cannot start right now, or null when it can. */
export function releaseBlockedText(status: GitPageStatus): string | null {
  if (!status.isGitRepo) return 'This project folder is not a git repository.';
  if (status.releaseJob?.state === 'running') return 'A release is running.';
  if (status.release.ok) return null;
  return status.release.reason ?? 'A release is not possible right now.';
}

/** The branches the Branches tab lists, and the run branches (`emberline/…`) kept behind a count. */
export function splitBranches(branches: GitBranch[]): { shown: GitBranch[]; runBranches: GitBranch[] } {
  return {
    shown: branches.filter((b) => b.kind !== 'run'),
    runBranches: branches.filter((b) => b.kind === 'run'),
  };
}

export const GIT_TABS = ['commits', 'branches', 'release'] as const;
export type GitTab = (typeof GIT_TABS)[number];

/** The tab a URL hash names (`#branches`); the Commits tab for anything else. */
export function tabFromHash(hash: string): GitTab {
  const name = hash.replace(/^#/, '');
  return (GIT_TABS as readonly string[]).includes(name) ? (name as GitTab) : 'commits';
}

/** How often the page reads its status: fast while a release or a draft is in progress. */
export function gitRefetchMs(status: GitPageStatus | undefined): number {
  return status?.releaseJob?.state === 'running' || status?.releaseDraft?.status === 'drafting'
    ? 5_000
    : 60_000;
}
