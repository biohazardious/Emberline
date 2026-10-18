import type { GarbageCollectRunsResponse } from '@emberline/protocol';

/** One sentence on worktrees garbage collection kept so no work is lost; null when none were. */
export function keptWorktreesSummary(res: Pick<GarbageCollectRunsResponse, 'keptWorktrees'>): string | null {
  const kept = res.keptWorktrees;
  if (kept.length === 0) return null;
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
  return `Kept ${kept.length} worktree${kept.length === 1 ? '' : 's'} so no work is lost: ${parts.join(', ')}.`;
}
