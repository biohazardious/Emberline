export type ScopedView = 'inbox' | 'fleet' | 'docker';
export const ALL_PROJECTS_KEYS: Record<ScopedView, string> = {
  inbox: 'emberline.inbox.allProjects',
  fleet: 'emberline.fleet.allProjects',
  docker: 'emberline.docker.allProjects',
};
export const ALL_PROJECTS_LABEL = 'All projects';

export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface Scope {
  activeProjectId: string | null;
  all: boolean;
}

function defaultStorage(): FlagStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered toggle; off when storage is missing or throws. */
export function readAllProjects(view: ScopedView, storage: FlagStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(ALL_PROJECTS_KEYS[view]) === '1';
  } catch {
    return false;
  }
}

/** Remembers the toggle; a storage failure is ignored (the choice lasts for the visit). */
export function writeAllProjects(
  view: ScopedView,
  on: boolean,
  storage: FlagStorage | null = defaultStorage(),
): void {
  try {
    if (on) storage?.setItem(ALL_PROJECTS_KEYS[view], '1');
    else storage?.removeItem(ALL_PROJECTS_KEYS[view]);
  } catch {
    // Storage unavailable: the choice lasts for this visit.
  }
}

/** The active project's items; all of them with "All projects" on or no active project. `null` project ids show only under "All projects". */
export function inScope<T>(items: readonly T[], projectIdOf: (item: T) => string | null, scope: Scope): T[] {
  if (scope.all || !scope.activeProjectId) return [...items];
  return items.filter((item) => projectIdOf(item) === scope.activeProjectId);
}

/** How many items the scope leaves out (0 with "All projects" on or no active project). */
export function outOfScope<T>(
  items: readonly T[],
  projectIdOf: (item: T) => string | null,
  scope: Scope,
): number {
  return items.length - inScope(items, projectIdOf, scope).length;
}

/** The line under a filtered view: "N more in other projects"; null for none. */
export function moreInOtherProjects(count: number): string | null {
  return count > 0 ? `${count} more in other projects` : null;
}
