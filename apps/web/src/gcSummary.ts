import type { GarbageCollectRunsResponse } from '@emberline/protocol';

/** One sentence on worktrees garbage collection kept so no work is lost; null when none were. */
export function keptWorktreesSummary(res: Pick<GarbageCollectRunsResponse, 'keptWorktrees'>): string | null {
  const kept = res.keptWorktrees;
  if (kept.length === 0) return null;
  const count = (reason: string) => kept.filter((k) => k.reason === reason).length;
  const parts = (
    [
      [count('uncommitted_changes'), 'uncommitted changes'],
      [count('unmerged_commits'), 'commits not merged into the main branch'],
      [count('in_review'), 'a ticket still in review'],
    ] as const
  )
    .filter(([n]) => n)
    .map(([n, why]) => `${n} with ${why}`);
  return `Kept ${kept.length} worktree${kept.length === 1 ? '' : 's'} so no work is lost: ${parts.join(', ')}.`;
}
