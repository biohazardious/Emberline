/** How fresh a target's demo build is, for Preview & Build (build records from the status API). */
import type { WorkspaceDemoTarget } from '@emberline/protocol';
import { timeAgo } from './time';

type Freshness = Pick<WorkspaceDemoTarget, 'kind' | 'exists' | 'demoBuild' | 'demoStale' | 'rebuilding'>;

/** "Built 5m ago from 0123456", "Build failed …", "Not built yet", or "Rebuilding…" while one runs. */
export function builtLine(target: Freshness, now = Date.now()): string {
  if (target.rebuilding) return 'Rebuilding…';
  const build = target.demoBuild;
  if (!build) return 'Not built yet';
  const from = build.commit ? ` from ${build.commit.slice(0, 7)}` : '';
  return `${build.ok ? 'Built' : 'Build failed'} ${timeAgo(build.builtAt, now)}${from}`;
}

/** The badge of a demo older than its workspace; null when fresh or while it is being rebuilt. */
export function staleBadge(target: Freshness): string | null {
  if (!target.demoStale || target.rebuilding) return null;
  return target.kind === 'main' ? 'main changed since this build' : 'changed since this build';
}

/**
 * Whether opening this target should start a build: it is stale, no build runs (started here, or in
 * core such as the rebuild after a merge), and none was started for it since the tab was opened.
 */
export function shouldAutoBuild(
  target: Freshness,
  state: { building: boolean; alreadyStarted: boolean },
): boolean {
  return target.exists && target.demoStale && !target.rebuilding && !state.building && !state.alreadyStarted;
}
