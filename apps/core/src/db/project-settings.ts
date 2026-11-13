import {
  CommitIdentity,
  GitSync,
  IssueSyncSettings,
  MainPushTarget,
  ProjectImportSource,
  ReleaseDraft,
  ReleaseJob,
} from '@emberline/protocol';
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
export function writeProjectSettings(
  db: Db,
  projectId: string,
  patch: ProjectSettingsDoc,
): ProjectSettingsDoc {
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

/**
 * An `import_url` project's clone: the branch it was asked for (null: the remote's default),
 * whether it waits for its own SSH key to be added on the forge before the first clone (Ruling 21),
 * and whether import-status has seen it finish (Ruling 24; absent: not yet).
 */
export const ImportClone = z.object({
  branch: z.string().nullable(),
  awaitingKey: z.boolean(),
  cloned: z.boolean().optional(),
});
export type ImportClone = z.infer<typeof ImportClone>;

/** Null for a project that is not an import of a URL, or one imported before 0.7.0. */
export function readImportClone(db: Db, projectId: string): ImportClone | null {
  const parsed = ImportClone.safeParse(readProjectSettings(db, projectId).importClone);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether an import's clone has not been seen to finish (it waits for its key, runs or failed),
 * from what core recorded alone: nothing runs. False for any other project and for imports from
 * before 0.7.0.
 */
export function readImportUnfinished(db: Db, projectId: string): boolean {
  const clone = readImportClone(db, projectId);
  return clone !== null && clone.cloned !== true;
}

/** import-status saw the clone finish: the project list stops calling the import unfinished. */
export function markImportCloned(db: Db, projectId: string): void {
  const clone = readImportClone(db, projectId);
  if (clone && clone.cloned !== true)
    writeProjectSettings(db, projectId, { importClone: { ...clone, cloned: true } });
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

/** The last read of origin (refresh, connect, create, push): what status shows without touching the network. */
export interface RemoteCheck {
  /** origin as shown (never with a password). */
  url: string;
  /**
   * Which origin was read: secretDigest('origin', origin as configured), so two origins shown alike
   * never share a read. Absent from 0.6.0 and earlier, whose `url` was remoteUrlForDisplay's `url`.
   */
  originKey?: string;
  branch: string;
  /** ISO time. */
  at: string;
  /** The remote has the branch. */
  published: boolean;
  /** Why origin could not be read (redacted); published is false then. */
  error: string | null;
}
/**
 * Keep main pushed's push that has not run yet (one per project: the newest merge). Kept across a
 * restart; only `commitOid`, the merge's own full id, is ever pushed.
 */
const PendingMainPushSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  commitOid: z.string().nullable(),
  unverified: z.boolean(),
  queuedAt: z.string(),
  /** The connected repository (projects.repoUrl, without credentials) when it was queued; absent from 0.5.0. */
  origin: z.string().nullable().optional(),
});
export type PendingMainPush = z.infer<typeof PendingMainPushSchema>;
/**
 * Project settings → Repository: the opt-in automatic push (where it goes, its last failure), the
 * last read of origin, and the project's own commit identity.
 */
export interface RepositorySettings {
  keepMainPushed: boolean;
  /**
   * Where Keep main pushed pushes. Absent: stored before 0.8.0 (or never chosen); see
   * effectivePushTarget.
   */
  pushTarget?: MainPushTarget;
  /** Absent: DEFAULT_INTEGRATION_BRANCH. */
  integrationBranch?: string;
  lastMainPushError: string | null;
  lastRemoteCheck: RemoteCheck | null;
  pendingMainPush: PendingMainPush | null;
  /** null: the factory's commit identity. */
  commitIdentity: CommitIdentity | null;
  /** The branch the Git page treats as the working branch. Absent: the project's default branch. */
  workingBranch?: string;
  /** Whether core pulls the working branch from origin by itself. On unless switched off. */
  autoPull: boolean;
  /** The outcome of the last pull; null before the first one. */
  sync: GitSync | null;
  /** Commits that arrived by a pull, so the history can mark them as from origin. */
  pulledOids: string[];
  /**
   * What the last pull that stopped for the person (a conflict, a rewritten origin) was about:
   * origin's tips then, and what it merged. Auto-pull leaves the project alone until origin moves
   * past these or the person acts; null when no such stop stands.
   */
  syncStop: SyncStop | null;
  /**
   * Tags here that name something other than origin's tag of the same name, as the last read of
   * origin found them. Emberline never moves a local tag; the Git page says which ones differ.
   */
  tagsDifferFromOrigin: string[];
  /**
   * origin's tags named like a branch here or on origin, as the last read found them: never created
   * here, since a tag beside a branch of the same name makes git's short names ambiguous.
   */
  tagsNamedLikeBranches: string[];
  releaseDraft: ReleaseDraft | null;
  releaseJob: ReleaseJob | null;
}
const SyncStopSchema = z.object({
  working: z.string().nullable(),
  main: z.string().nullable(),
  /** What was being merged: `origin/<branch>`, or the default branch merged into the working branch. */
  source: z.string(),
  /**
   * The commit that was being merged. Once the working branch has it (a "Resolve with a ticket" run
   * merged it in), auto-pull tries again. Absent in stops stored before it was kept.
   */
  sourceTip: z.string().nullable().optional(),
  /** The ticket "Resolve with a ticket" made for this stop: asked again, it is the answer while open. */
  ticketId: z.string().optional(),
});
export type SyncStop = z.infer<typeof SyncStopSchema>;
const RemoteCheckSchema = z.object({
  url: z.string(),
  originKey: z.string().optional(),
  branch: z.string(),
  at: z.string(),
  published: z.boolean(),
  error: z.string().nullable(),
});
const RepositorySettingsSchema = z.object({
  keepMainPushed: z.boolean().catch(false).default(false),
  pushTarget: MainPushTarget.optional().catch(undefined),
  integrationBranch: z.string().optional().catch(undefined),
  lastMainPushError: z.string().nullable().catch(null).default(null),
  lastRemoteCheck: RemoteCheckSchema.nullable().catch(null).default(null),
  pendingMainPush: PendingMainPushSchema.nullable().catch(null).default(null),
  commitIdentity: CommitIdentity.nullable().catch(null).default(null),
  workingBranch: z.string().optional().catch(undefined),
  autoPull: z.boolean().catch(true).default(true),
  sync: GitSync.nullable().catch(null).default(null),
  pulledOids: z.array(z.string()).max(500).catch([]).default([]),
  syncStop: SyncStopSchema.nullable().catch(null).default(null),
  tagsDifferFromOrigin: z.array(z.string()).max(100).catch([]).default([]),
  tagsNamedLikeBranches: z.array(z.string()).max(100).catch([]).default([]),
  releaseDraft: ReleaseDraft.nullable().catch(null).default(null),
  releaseJob: ReleaseJob.nullable().catch(null).default(null),
});
/**
 * The working branch the factory must merge into when the project stores one other than its default
 * branch; null otherwise (the factory merges into whatever is checked out, as before).
 */
export function factoryWorkingBranch(db: Db, projectId: string, defaultBranch: string): string | null {
  const stored = readRepositorySettings(db, projectId).workingBranch;
  return stored && stored !== defaultBranch ? stored : null;
}
/** The branch the Git page works on: the stored choice, else the project's default branch. */
export function workingBranchOf(settings: RepositorySettings, defaultBranch: string): string {
  return settings.workingBranch ?? defaultBranch;
}
/**
 * Where Keep main pushed pushes: the stored choice; without one, a project that already pushes
 * automatically (switched on before 0.8.0) keeps pushing its default branch, and one that opts in
 * now gets the integration branch.
 */
export function effectivePushTarget(settings: RepositorySettings): MainPushTarget {
  return settings.pushTarget ?? (settings.keepMainPushed ? 'default_branch' : 'integration_branch');
}

export function readRepositorySettings(db: Db, projectId: string): RepositorySettings {
  return RepositorySettingsSchema.parse(readProjectSettings(db, projectId).repository ?? {});
}
export function writeRepositorySettings(
  db: Db,
  projectId: string,
  patch: Partial<RepositorySettings>,
): RepositorySettings {
  const next = { ...readRepositorySettings(db, projectId), ...patch };
  writeProjectSettings(db, projectId, { repository: next });
  return next;
}
