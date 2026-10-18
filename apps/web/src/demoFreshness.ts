/** How fresh a target's demo build is, for Preview & Build (build records from the status API). */
import type { WorkspaceDemoTarget } from '@emberline/protocol';
import { timeAgo } from './time';

type Freshness = Pick<
  WorkspaceDemoTarget,
  'kind' | 'runStatus' | 'exists' | 'demoBuild' | 'demoStale' | 'rebuilding'
>;

/**
 * "Built 5m ago from 0123456", "Build failed …", "Not built yet", "Build not recorded" (a demo is on
 * disk but no build of it was recorded), or "Rebuilding…" while one runs.
 */
export function builtLine(target: Freshness, now = Date.now()): string {
  if (target.rebuilding) return 'Rebuilding…';
  const build = target.demoBuild;
  if (!build) return target.demoStale ? 'Build not recorded' : 'Not built yet';
  const from = build.commit ? ` from ${build.commit.slice(0, 7)}` : '';
  return `${build.ok ? 'Built' : 'Build failed'} ${timeAgo(build.builtAt, now)}${from}`;
}

/** The badge of a demo older than its workspace; null when fresh or while it is being rebuilt. */
export function staleBadge(target: Freshness): string | null {
  if (!target.demoStale || target.rebuilding) return null;
  // Without a record nobody knows which commit the demo on disk came from.
  if (!target.demoBuild) return 'may be out of date';
  return target.kind === 'main' ? 'main changed since this build' : 'changed since this build';
}

/**
 * Whether opening this target should start a build: it is stale, no build runs (started here, or in
 * core such as the rebuild after a merge), and none was started for it since the tab was opened.
 * Only main or a finished run: a run whose agent may still be working is left alone.
 */
export function shouldAutoBuild(
  target: Freshness,
  state: { building: boolean; alreadyStarted: boolean },
): boolean {
  const finished = target.kind === 'main' || target.runStatus === 'done' || target.runStatus === 'failed';
  return (
    finished &&
    target.exists &&
    target.demoStale &&
    !target.rebuilding &&
    !state.building &&
    !state.alreadyStarted
  );
}
