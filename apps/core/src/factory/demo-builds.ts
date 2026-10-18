/**
 * Demo build records: which commit each target's demo was last built from, so Preview & Build can
 * say how old a demo is and whether its workspace has moved on since (project settings `demoBuilds`).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DemoBuildRecord } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readProjectSettings, writeProjectSettings } from '../db/project-settings.js';
import { runs } from '../db/schema.js';
import { execGitFile } from '../git-exec.js';

/** The project settings key: a map from target id ('main' or a run id) to its last build. */
export const DEMO_BUILDS_KEY = 'demoBuilds';

/** The recorded builds by target; entries that do not validate are left out. */
export function readDemoBuilds(db: Db, projectId: string): Record<string, DemoBuildRecord> {
  const stored = readProjectSettings(db, projectId)[DEMO_BUILDS_KEY];
  const builds: Record<string, DemoBuildRecord> = {};
  if (!stored || typeof stored !== 'object') return builds;
  for (const [targetId, value] of Object.entries(stored)) {
    const parsed = DemoBuildRecord.safeParse(value);
    if (parsed.success) builds[targetId] = parsed.data;
  }
  return builds;
}

/**
 * Records a target's build, replacing its earlier one. Entries of runs that no longer exist are
 * dropped on the way. Synchronous (one SQLite read and write), so two builds finishing at once
 * cannot lose each other's record.
 */
export function recordDemoBuild(db: Db, projectId: string, targetId: string, build: DemoBuildRecord): void {
  const runIds = new Set(
    db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .all()
      .map((r) => r.id),
  );
  const kept = Object.entries(readDemoBuilds(db, projectId)).filter(
    ([id]) => id === 'main' || runIds.has(id),
  );
  writeProjectSettings(db, projectId, {
    [DEMO_BUILDS_KEY]: { ...Object.fromEntries(kept), [targetId]: build },
  });
}

/**
 * Whether a target's demo is older than its workspace: the workspace HEAD differs from the commit
 * the build was made from, or a demo is on disk that no recorded build made. Without a HEAD (not a
 * git repository) it cannot tell and says no.
 */
export function isDemoStale(params: {
  head: string | null;
  build: DemoBuildRecord | null;
  hasDemoEntry: boolean;
}): boolean {
  const { head, build, hasDemoEntry } = params;
  if (!build) return hasDemoEntry;
  if (head === null) return false;
  return build.commit !== head;
}

/**
 * The workspace HEAD a build starts from, as git reports it (in the runner). Null outside a git
 * repository of its own, or when git does not answer with a commit id.
 */
export async function buildStartCommit(workspacePath: string): Promise<string | null> {
  // Not a repository of its own: git would answer for an enclosing one.
  if (!existsSync(path.join(workspacePath, '.git'))) return null;
  const sha = await execGitFile(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], {
    cwd: workspacePath,
  }).then(
    (res) => res.stdout.trim(),
    () => '',
  );
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
}
