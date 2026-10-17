import { IssueSyncSettings } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from './index.js';
import { projectSettings } from './schema.js';

/** The per-project settings document. Each feature owns one top-level key. */
export interface ProjectSettingsDoc {
  issueSync?: unknown;
  [key: string]: unknown;
}

export function readProjectSettings(db: Db, projectId: string): ProjectSettingsDoc {
  const row = db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId)).get();
  return row && typeof row.settings === 'object' && row.settings !== null ? row.settings : {};
}

/** Merges `patch` into the stored document (other keys are kept). */
export function writeProjectSettings(db: Db, projectId: string, patch: ProjectSettingsDoc): ProjectSettingsDoc {
  const next = { ...readProjectSettings(db, projectId), ...patch };
  db.insert(projectSettings)
    .values({ projectId, settings: next })
    .onConflictDoUpdate({ target: projectSettings.projectId, set: { settings: next } })
    .run();
  return next;
}

/** Issue sync settings with defaults; a stored value that no longer validates falls back to the defaults. */
export function readIssueSync(db: Db, projectId: string): IssueSyncSettings {
  const parsed = IssueSyncSettings.safeParse(readProjectSettings(db, projectId).issueSync ?? {});
  return parsed.success ? parsed.data : IssueSyncSettings.parse({});
}

export function writeIssueSync(db: Db, projectId: string, value: IssueSyncSettings): void {
  writeProjectSettings(db, projectId, { issueSync: value });
}
