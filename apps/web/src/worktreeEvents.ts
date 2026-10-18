/** Run timeline labels for the worktree lifecycle events (worktree.yml copy, setup, teardown, prune). */
export const WORKTREE_EVENT_LABELS: Record<string, string> = {
  worktree_copied: 'files copied into the worktree',
  worktree_copy_skipped: 'copy skipped',
  worktree_setup_pending: 'worktree setup queued',
  worktree_setup_started: 'worktree setup started',
  worktree_setup_finished: 'worktree setup finished',
  worktree_setup_failed: 'worktree setup failed',
  worktree_setup_skipped: 'worktree setup cut short',
  worktree_teardown_failed: 'worktree teardown failed',
  worktree_pruned: 'worktree pruned',
};
