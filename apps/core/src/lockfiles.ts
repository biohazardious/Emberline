import path from 'node:path';

/**
 * Package-manager lockfiles, by basename. Many tickets touch them on purpose, so a claim of one
 * never makes a ticket wait (tickets/overlap.ts); and two sides' additions to one are not a valid
 * lockfile, so the conflict heal (factory/conflict-heal.ts) never stitches a conflict in one together
 * and leaves it to the conflict ladder (the agent re-runs its package manager).
 */
export const LOCKFILES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'flake.lock',
  'pubspec.lock',
]);

/** Whether a repo-relative path (any depth) is a lockfile. */
export const isLockfile = (file: string): boolean => LOCKFILES.has(path.posix.basename(file));
