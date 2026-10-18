import { describe, expect, it } from 'vitest';
import { WORKTREE_EVENT_LABELS } from './worktreeEvents';

describe('WORKTREE_EVENT_LABELS', () => {
  it('labels every worktree lifecycle event core records', () => {
    const recorded = [
      'worktree_copied',
      'worktree_copy_skipped',
      'worktree_setup_pending',
      'worktree_setup_started',
      'worktree_setup_finished',
      'worktree_setup_failed',
      'worktree_setup_skipped',
      'worktree_teardown_failed',
      'worktree_pruned',
    ];
    for (const type of recorded) expect(WORKTREE_EVENT_LABELS[type], type).toBeTruthy();
  });
});
