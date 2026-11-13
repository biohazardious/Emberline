import { z } from 'zod';

/** How a local branch stands against its counterpart on origin. */
export const BranchRemoteState = z.enum([
  'up_to_date',
  'behind',
  'ahead',
  'diverged',
  'rewritten',
  'unpublished',
  'unknown',
]);
export type BranchRemoteState = z.infer<typeof BranchRemoteState>;

/** The outcome of the last pull of the working branch from origin. */
export const GitSyncState = z.enum([
  'idle',
  'up_to_date',
  'pulled',
  'conflict',
  'diverged',
  'rewritten',
  'main_unpushed',
  'workspace_dirty',
  'no_remote',
  'error',
]);
export type GitSyncState = z.infer<typeof GitSyncState>;

export const GitSync = z.object({
  state: GitSyncState,
  at: z.string().nullable(),
  branch: z.string().nullable(),
  files: z.array(z.string()),
  message: z.string().nullable(),
});
export type GitSync = z.infer<typeof GitSync>;

export const GitRefLabel = z.object({
  kind: z.enum(['branch', 'tag', 'origin', 'working', 'main', 'backup']),
  name: z.string(),
});
export type GitRefLabel = z.infer<typeof GitRefLabel>;

export const GitCommitSummary = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),
  parents: z.array(z.string()),
  byFactory: z.boolean(),
  ticketKey: z.string().nullable(),
  ticketId: z.string().nullable(),
  labels: z.array(GitRefLabel),
  fromOrigin: z.boolean(),
});
export type GitCommitSummary = z.infer<typeof GitCommitSummary>;

export const GitCommitsPage = z.object({
  ref: z.string(),
  commits: z.array(GitCommitSummary),
  nextCursor: z.number().int().nullable(),
});
export type GitCommitsPage = z.infer<typeof GitCommitsPage>;

export const GitFileChange = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
});
export type GitFileChange = z.infer<typeof GitFileChange>;

export const GitCommitDetail = z.object({
  sha: z.string(),
  message: z.string(),
  parents: z.array(z.string()),
  files: z.array(GitFileChange),
});
export type GitCommitDetail = z.infer<typeof GitCommitDetail>;

export const GitFileDiff = z.object({
  path: z.string(),
  original: z.string(),
  modified: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type GitFileDiff = z.infer<typeof GitFileDiff>;

export const GitCompare = z.object({
  base: z.string(),
  head: z.string(),
  mergeBase: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  files: z.array(GitFileChange),
});
export type GitCompare = z.infer<typeof GitCompare>;

/** `origin`: a branch only on origin (as last read), with no local branch of that name. */
export const GitBranchKind = z.enum(['working', 'main', 'person', 'run', 'backup', 'origin']);
export type GitBranchKind = z.infer<typeof GitBranchKind>;

export const GitBranch = z.object({
  name: z.string(),
  kind: GitBranchKind,
  tip: z.string(),
  subject: z.string(),
  vsMain: z.object({ ahead: z.number().int(), behind: z.number().int() }).nullable(),
  vsOrigin: z
    .object({
      state: BranchRemoteState,
      ahead: z.number().int().nullable(),
      behind: z.number().int().nullable(),
    })
    .nullable(),
  mergedIntoMain: z.boolean(),
  mergedIntoWorking: z.boolean(),
  liveRuns: z.array(z.string()),
});
export type GitBranch = z.infer<typeof GitBranch>;

export const ReleaseStepName = z.enum([
  'promote',
  'checks',
  'changelog',
  'push_main',
  'tag',
  'push_tag',
  'forge_release',
  'sync_working',
]);
export type ReleaseStepName = z.infer<typeof ReleaseStepName>;

export const ReleaseStep = z.object({
  name: ReleaseStepName,
  status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']),
  detail: z.string().nullable(),
});
export type ReleaseStep = z.infer<typeof ReleaseStep>;

export const ReleaseJob = z.object({
  id: z.string(),
  mode: z.enum(['publish', 'promote_only']),
  version: z.string().nullable(),
  notes: z.string().nullable(),
  /** The working branch's tip the person approved: what the promote merges, and nothing more. */
  head: z.string(),
  /** The working branch the release was started on. */
  working: z.string(),
  state: z.enum(['running', 'failed', 'done', 'undone']),
  steps: z.array(ReleaseStep),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  previousMain: z.string().nullable(),
  /** The commit the checks last ran on (or found nothing to check at); null before they did. */
  checked: z.string().nullable(),
  promoteOid: z.string().nullable(),
  releaseCommit: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  error: z.string().nullable(),
});
export type ReleaseJob = z.infer<typeof ReleaseJob>;

export const ReleaseDraft = z.object({
  status: z.enum(['drafting', 'ready', 'failed']),
  head: z.string(),
  baseTag: z.string().nullable(),
  version: z.string().nullable(),
  bump: z.enum(['patch', 'minor', 'major']).nullable(),
  notes: z.string(),
  agent: z.string().nullable(),
  error: z.string().nullable(),
  at: z.string(),
});
export type ReleaseDraft = z.infer<typeof ReleaseDraft>;

export const GitPageStatus = z.object({
  isGitRepo: z.boolean(),
  defaultBranch: z.string(),
  workingBranch: z.string(),
  checkedOut: z.string().nullable(),
  workingMismatch: z.boolean(),
  mainBehindWorking: z.number().int(),
  latestTag: z.string().nullable(),
  hasOrigin: z.boolean(),
  originUrl: z.string().nullable(),
  working: BranchRemoteState,
  main: BranchRemoteState,
  /** Commits ahead of and behind origin's branch as last read; null when unknown (no origin, not read yet). */
  workingCounts: z.object({ ahead: z.number().int(), behind: z.number().int() }).nullable(),
  mainCounts: z.object({ ahead: z.number().int(), behind: z.number().int() }).nullable(),
  checkedAt: z.string().nullable(),
  autoPull: z.boolean(),
  sync: GitSync,
  forgeRelease: z.boolean(),
  release: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  releaseJob: ReleaseJob.nullable(),
  releaseDraft: ReleaseDraft.nullable(),
  /** What a release would carry: the working tip, its commit and ticket counts, and the checks it runs. */
  releaseSummary: z.object({
    head: z.string().nullable(),
    commits: z.number().int(),
    tickets: z.number().int(),
    checks: z.array(z.string()),
    /** Whether the release commit would add the notes to a CHANGELOG.md (main has one, or gets one by the promote). */
    hasChangelog: z.boolean(),
  }),
  backups: z.array(z.string()),
  /** Tags here on another commit than origin's tag of that name (never moved by Emberline); compared by commit. */
  tagsDifferFromOrigin: z.array(z.string()),
  /** origin's tags named like a branch, which Emberline does not create here. */
  tagsNamedLikeBranches: z.array(z.string()),
  /** Some of origin's branches or tags could not be fetched at the last read; Emberline tries again later. */
  originRefsUnread: z.boolean(),
  /**
   * The commits (merges left out) of the working branch and of main that origin has neither as they
   * are nor as the same patch: what Match origin would keep only in the backup. Known (else null)
   * when the branch has diverged from origin's or origin was rewritten.
   */
  notOnOrigin: z.object({ working: z.number().int().nullable(), main: z.number().int().nullable() }),
});
export type GitPageStatus = z.infer<typeof GitPageStatus>;

export const UpdateGitSettingsBody = z.object({ autoPull: z.boolean().optional() });
export type UpdateGitSettingsBody = z.infer<typeof UpdateGitSettingsBody>;

export const SetWorkingBranchBody = z.object({ branch: z.string() });
export type SetWorkingBranchBody = z.infer<typeof SetWorkingBranchBody>;

/** `origin`: the local branch `name` at origin's `name` (as last read), for a branch only on origin. */
export const CreateBranchBody = z.object({ name: z.string(), from: z.enum(['main', 'working', 'origin']) });
export type CreateBranchBody = z.infer<typeof CreateBranchBody>;

export const MatchOriginBody = z.object({ branch: z.string().min(1) });
export type MatchOriginBody = z.infer<typeof MatchOriginBody>;

/** A release version as a person types it: an optional "v", three numbers, an optional pre-release. */
export const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const StartReleaseBody = z.object({
  mode: z.enum(['publish', 'promote_only']),
  version: z.string().optional(),
  notes: z.string().optional(),
  head: z.string(),
});
export type StartReleaseBody = z.infer<typeof StartReleaseBody>;
