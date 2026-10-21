import { IssueSyncSettings, ProjectImportSource } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
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

/** Where the project's folder came from; null for projects created before it was recorded. */
export function readImportSource(db: Db, projectId: string): ProjectImportSource | null {
  const parsed = ProjectImportSource.safeParse(readProjectSettings(db, projectId).importSource);
  return parsed.success ? parsed.data : null;
}

/** Which tickets of a wizard project play which role. */
export const WizardTickets = z.object({
  bootstrap: z.string(),
  deploy: z.string().optional(),
  factory: z.string().optional(),
  bootstrapWritesWorktree: z.boolean(),
});
export type WizardTickets = z.infer<typeof WizardTickets>;

/** The wizard's ticket roles; null for projects created before 0.4.0 or not by the wizard (or a value that no longer parses). */
export function readWizardTickets(db: Db, projectId: string): WizardTickets | null {
  const parsed = WizardTickets.safeParse(readProjectSettings(db, projectId).wizardTickets);
  return parsed.success ? parsed.data : null;
}

export function writeWizardTickets(db: Db, projectId: string, value: WizardTickets): void {
  writeProjectSettings(db, projectId, { wizardTickets: value });
}
