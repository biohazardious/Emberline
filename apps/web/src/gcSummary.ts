import type { GarbageCollectRunsResponse, Run, RunEvent } from '@emberline/protocol';

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
export const PRUNE_FAILED_TEXT = 'The teardown ended, but the worktree could not be removed. Prune it again.';

/** A run's Prune that goes on in the background: its outcome is the first outcome event after `since`. */
export interface PrunePending {
  runId: string;
  /** The run's newest event id when the prune began (null: not told, from an older core). */
  since: number | null;
}

const PRUNE_OUTCOMES = new Set(['worktree_pruned', 'worktree_prune_failed']);

/**
 * The note after a run's Prune whose worktree.yml teardown outlasted the request: shown until that
 * prune's outcome (the newest `worktree_pruned` or `worktree_prune_failed` event after `since`) is known or
 * the run is gone, and while the runs are not known yet. A failed prune says so, whatever happens on
 * the run after it. `events`: the run's events, when loaded; until then its latest event stands in.
 */
export function prunePendingNote(
  pending: PrunePending | undefined,
  runs: readonly Pick<Run, 'id' | 'lastEvent'>[] | undefined,
  events?: readonly Pick<RunEvent, 'id' | 'type'>[],
): { text: string; failed: boolean } | null {
  if (!pending) return null;
  const run = runs?.find((r) => r.id === pending.runId);
  if (runs && !run) return null;
  const outcome = events
    ? events
        .filter((e) => PRUNE_OUTCOMES.has(e.type) && (pending.since === null || e.id > pending.since))
        .at(-1)?.type
    : run?.lastEvent;
  if (outcome === 'worktree_pruned') return null;
  if (outcome === 'worktree_prune_failed') return { text: PRUNE_FAILED_TEXT, failed: true };
  return { text: PRUNE_PENDING_TEXT, failed: false };
}
