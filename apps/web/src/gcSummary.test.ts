import { describe, expect, it } from 'vitest';
import { keptWorktreesSummary } from './gcSummary';

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
