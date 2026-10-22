/**
 * Demo targets: which workspace a target id names ('main' or a run of the project) and the URL
 * agents and the runner's browser use to reach its demo on core. Shared by the demo routes and the
 * runner-facing preview URL (runs/browser-url.ts).
 */
import { eq } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { projects, runs } from '../db/schema.js';
import { AGENT_DEMO_TOKEN_TTL_MS, type DemoTokens, demoBasePath } from '../demo-token.js';

/** The workspace of `targetId`: the project's main path, or the worktree of one of its own runs; null otherwise. */
export function demoWorkspacePath(db: Db, projectId: string, targetId: string): string | null {
  const project = db
    .select({ id: projects.id, path: projects.path })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) return null;
  if (targetId === 'main') return project.path;
  const run = db
    .select({ projectId: runs.projectId, worktreePath: runs.worktreePath })
    .from(runs)
    .where(eq(runs.id, targetId))
    .get();
  return run && run.projectId === project.id ? run.worktreePath : null;
}

/** The demo URL agents and the runner's browser use (no session cookie there): `${hookUrl}/api/demo/<7-day token>/`. */
export function agentDemoUrl(
  config: Pick<CoreConfig, 'hookUrl'>,
  tokens: DemoTokens,
  projectId: string,
  targetId: string,
): string {
  return `${config.hookUrl}${demoBasePath(tokens.mint({ projectId, targetId }, AGENT_DEMO_TOKEN_TTL_MS))}`;
}
