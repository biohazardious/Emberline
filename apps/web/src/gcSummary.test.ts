import { describe, expect, it } from 'vitest';
import { keptWorktreesSummary, PRUNE_PENDING_TEXT, prunePendingNote } from './gcSummary';

describe('keptWorktreesSummary', () => {
  it('says nothing when nothing was left behind', () => {
    expect(keptWorktreesSummary({ keptWorktrees: [] })).toBeNull();
  });

  it('keeps the worktrees it kept apart from runs left because a prune of their worktree was running', () => {
    expect(
      keptWorktreesSummary({
        keptWorktrees: [
          { runId: 'a', reason: 'prune_running' },
          { runId: 'b', reason: 'archive_pending' },
        ],
      }),
    ).toBe(
      'Kept 1 worktree so no work is lost: 1 with build outputs not archived in time (run the clean-up again). Left 1 run for the next clean-up: its worktree was being pruned.',
    );
    expect(
      keptWorktreesSummary({
        keptWorktrees: [
          { runId: 'a', reason: 'prune_running' },
          { runId: 'c', reason: 'prune_running' },
        ],
      }),
    ).toBe('Left 2 runs for the next clean-up: their worktrees were being pruned.');
  });
});

describe('prunePendingNote (W-4)', () => {
  const runs = [
    { id: 'r1', lastEvent: 'Stop' },
    { id: 'r2', lastEvent: 'worktree_pruned' },
  ];

  it('says the teardown is still running while the pruned run keeps its worktree', () => {
    expect(prunePendingNote('r1', runs)).toBe(PRUNE_PENDING_TEXT);
    expect(prunePendingNote('r1', undefined)).toBe(PRUNE_PENDING_TEXT);
    expect(PRUNE_PENDING_TEXT).toBe('Teardown is running; the worktree is removed when it ends.');
  });

  it('goes once the teardown ended: the worktree was pruned, or the run is gone', () => {
    expect(prunePendingNote('r2', runs)).toBeNull();
    expect(prunePendingNote('r3', runs)).toBeNull();
  });

  it('says nothing without a pending prune', () => {
    expect(prunePendingNote(undefined, runs)).toBeNull();
  });
});
