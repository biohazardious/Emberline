import { describe, expect, it } from 'vitest';
import { keptWorktreesSummary, PRUNE_PENDING_TEXT, pruneSummary } from './gcSummary';

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

describe('pruneSummary (W-4)', () => {
  it('says the teardown is still running when the prune finishes in the background', () => {
    expect(pruneSummary({ pending: true })).toBe(PRUNE_PENDING_TEXT);
    expect(PRUNE_PENDING_TEXT).toBe('Teardown is running; the worktree is removed when it ends.');
  });

  it('says nothing for a prune that finished', () => {
    expect(pruneSummary({})).toBeNull();
    expect(pruneSummary({ pending: false })).toBeNull();
  });
});
