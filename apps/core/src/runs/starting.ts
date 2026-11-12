import path from 'node:path';

/**
 * Run worktrees that exist but whose run row does not yet: a start between `git worktree add`
 * (prepareWorkspace, under the main-workspace lock) and the row's insert (RunService.enqueue). Kept
 * per main workspace, in memory, because only this core process starts runs; a start that ends,
 * either way, takes its entry out. A worktree left behind with no row is not starting.
 */
const starting = new Map<string, Map<string, string>>();

const keyOf = (mainPath: string) => path.resolve(mainPath);

/** A run's worktree is being added at `worktreePath` on `branch`. */
export function markStarting(mainPath: string, worktreePath: string, branch: string): void {
  const key = keyOf(mainPath);
  const entries = starting.get(key) ?? new Map<string, string>();
  entries.set(path.resolve(worktreePath), branch);
  starting.set(key, entries);
}

/** The start ended: its row exists now, or it failed. */
export function doneStarting(mainPath: string, worktreePath: string): void {
  const key = keyOf(mainPath);
  const entries = starting.get(key);
  if (!entries) return;
  entries.delete(path.resolve(worktreePath));
  if (entries.size === 0) starting.delete(key);
}

/** The starts in progress in this main workspace. */
export function startingWorktrees(mainPath: string): { path: string; branch: string }[] {
  return [...(starting.get(keyOf(mainPath)) ?? new Map<string, string>())].map(([p, branch]) => ({
    path: p,
    branch,
  }));
}
