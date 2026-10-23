import { describe, expect, it } from 'vitest';
import { keptWorktreesSummary } from './gcSummary';

describe('keptWorktreesSummary', () => {
  it('says nothing when no worktree was kept', () => {
    expect(keptWorktreesSummary({ keptWorktrees: [] })).toBeNull();
  });

  it('names a run left alone because a prune of its worktree was running', () => {
    expect(
      keptWorktreesSummary({
        keptWorktrees: [
          { runId: 'a', reason: 'prune_running' },
          { runId: 'b', reason: 'archive_pending' },
        ],
      }),
    ).toBe(
      'Kept 2 worktrees so no work is lost: 1 with build outputs not archived in time (run the clean-up again), 1 with a prune already running (run the clean-up again to remove its run).',
    );
  });
});
