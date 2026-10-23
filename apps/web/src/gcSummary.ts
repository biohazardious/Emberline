import type { GarbageCollectRunsResponse, PruneWorktreeResponse } from '@emberline/protocol';

/**
 * What garbage collection left behind, in sentences: worktrees it kept so no work is lost, and runs
 * it left for the next clean-up because a prune of their worktree was running. Null when neither.
 */
export function keptWorktreesSummary(res: Pick<GarbageCollectRunsResponse, 'keptWorktrees'>): string | null {
  const pruning = res.keptWorktrees.filter((k) => k.reason === 'prune_running').length;
  const kept = res.keptWorktrees.filter((k) => k.reason !== 'prune_running');
  const count = (reason: string) => kept.filter((k) => k.reason === reason).length;
  const parts = (
    [
      [count('uncommitted_changes'), 'uncommitted changes'],
      [
        count('unmerged_commits'),
        'commits not in the branch Emberline merges into (the one checked out in the project)',
      ],
      [count('in_review'), 'a ticket still in review'],
      [count('archive_pending'), 'build outputs not archived in time (run the clean-up again)'],
      [count('teardown_running'), 'its worktree.yml teardown still running (pruned when it ends)'],
    ] as const
  )
    .filter(([n]) => n)
    .map(([n, why]) => `${n} with ${why}`);
  const sentences = [
    kept.length > 0
      ? `Kept ${kept.length} worktree${kept.length === 1 ? '' : 's'} so no work is lost: ${parts.join(', ')}.`
      : null,
    pruning > 0
      ? `Left ${pruning} run${pruning === 1 ? '' : 's'} for the next clean-up: ${pruning === 1 ? 'its worktree was' : 'their worktrees were'} being pruned.`
      : null,
  ].filter((s): s is string => s !== null);
  return sentences.length > 0 ? sentences.join(' ') : null;
}

export const PRUNE_PENDING_TEXT = 'Teardown is running; the worktree is removed when it ends.';

/** What a run's Prune left to the background: its worktree.yml teardown outlasted the request. Null otherwise. */
export function pruneSummary(res: Pick<PruneWorktreeResponse, 'pending'>): string | null {
  return res.pending ? PRUNE_PENDING_TEXT : null;
}
