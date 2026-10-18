/** API contracts: review: git diff, commit/push & artifacts (M6). */
import { z } from 'zod';
import type { Run } from './runs.js';

/**
 * `branch` compares the working tree against the merge-base with the project's default branch.
 * `unstaged` is working tree vs index (including untracked files); `staged` is index vs HEAD.
 */
export const DiffScope = z.enum(['branch', 'unstaged', 'staged']);
export type DiffScope = z.infer<typeof DiffScope>;

export const DiffFileStatus = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']);
export type DiffFileStatus = z.infer<typeof DiffFileStatus>;

export const DiffFile = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: DiffFileStatus,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /**
   * Content hash: the git blob id of the worktree file, `link:<sha1 of the link text>` for a symlink,
   * `deleted:<old blob id>` for a deleted file, `unhashed:<status>:<adds>:<dels>` when unhashable.
   */
  hash: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const RunDiffSummary = z.object({
  runId: z.string(),
  isGitRepo: z.boolean(),
  branch: z.string().nullable(),
  baseBranch: z.string(),
  headSha: z.string().nullable(),
  aheadCount: z.number().int().nonnegative(),
  clean: z.boolean(),
  hasRemote: z.boolean(),
  scope: DiffScope,
  totalAdditions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  files: z.array(DiffFile),
});
export type RunDiffSummary = z.infer<typeof RunDiffSummary>;

export const RunFileDiff = z.object({
  path: z.string(),
  scope: DiffScope,
  status: DiffFileStatus,
  binary: z.boolean(),
  original: z.string(),
  modified: z.string(),
  patch: z.string(),
});
export type RunFileDiff = z.infer<typeof RunFileDiff>;

export const GitStageBody = z.object({
  paths: z.array(z.string().min(1).max(1024)).max(500).optional(),
  all: z.boolean().default(false),
  unstage: z.boolean().default(false),
});
export type GitStageBody = z.input<typeof GitStageBody>;

export const GitCommitBody = z.object({
  message: z.string().trim().min(1).max(4_000),
  stageAll: z.boolean().default(true),
});
export type GitCommitBody = z.input<typeof GitCommitBody>;

export const GitCommitResponse = z.object({
  sha: z.string(),
  branch: z.string().nullable(),
  summary: z.string(),
});
export type GitCommitResponse = z.infer<typeof GitCommitResponse>;

export const GitPushResponse = z.object({
  branch: z.string(),
  remote: z.string(),
  output: z.string(),
});
export type GitPushResponse = z.infer<typeof GitPushResponse>;

export const ArtifactKind = z.enum(['image', 'trace', 'log', 'document', 'file']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const RunArtifact = z.object({
  path: z.string(),
  name: z.string(),
  kind: ArtifactKind,
  sizeBytes: z.number().int().nonnegative(),
  mtime: z.string(),
});
export type RunArtifact = z.infer<typeof RunArtifact>;

/** A deliverable a run produced (APK, installer, firmware image, ...), wherever the build wrote it. */
export const RunBuildOutput = z.object({
  /** Path relative to the run's worktree. */
  path: z.string(),
  name: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mtime: z.string(),
  /** False for files git ignores (build directories), which never reach the main workspace by merge. */
  tracked: z.boolean(),
});
export type RunBuildOutput = z.infer<typeof RunBuildOutput>;

export const RunBuildOutputsResponse = z.object({
  /** The worktree inside the runner (`/workspaces/...`). */
  worktreePath: z.string(),
  /** The same directory on the host, when core knows the host path of the workspaces volume. */
  hostWorktreePath: z.string().nullable(),
  outputs: z.array(RunBuildOutput),
  /** Outputs archived from this run's handoff chain (they outlive the worktree). */
  archivedCount: z.number().int().min(0),
});
export type RunBuildOutputsResponse = z.infer<typeof RunBuildOutputsResponse>;

export const PruneWorktreeResponse = z.object({
  runId: z.string(),
  worktreePath: z.string(),
  removed: z.boolean(),
});
export type PruneWorktreeResponse = z.infer<typeof PruneWorktreeResponse>;

// --- persistent code review (Phase 4) ---------------------------------------

export const ReviewCommentStatus = z.enum(['open', 'sent', 'addressed', 'resolved']);
export type ReviewCommentStatus = z.infer<typeof ReviewCommentStatus>;

export const ReviewCommentIntent = z.enum(['fix', 'change', 'question', 'approve']);
export type ReviewCommentIntent = z.infer<typeof ReviewCommentIntent>;

export const ReviewCommentPriority = z.enum(['blocking', 'important', 'suggestion']);
export type ReviewCommentPriority = z.infer<typeof ReviewCommentPriority>;

export const ReviewComment = z.object({
  id: z.string(),
  runId: z.string(),
  filePath: z.string(),
  /** Null for a file-level comment. */
  line: z.number().int().nullable(),
  side: z.enum(['modified', 'original']),
  body: z.string(),
  intent: ReviewCommentIntent,
  priority: ReviewCommentPriority,
  /** The commented line's text at creation (trimmed, <= 500 chars); null for file-level comments. */
  anchorText: z.string().nullable(),
  /** The file's `hash` at creation. */
  anchorHash: z.string().nullable(),
  /** Incremented each time the comment is sent. */
  round: z.number().int().nonnegative(),
  verifiedAt: z.string().nullable(),
  /** Run the comment was carried to when feedback went to a new run. */
  carriedTo: z.string().nullable(),
  /** Computed on read, never stored: where the anchor text is now (null when outdated or file-level). */
  currentLine: z.number().int().nullable(),
  outdated: z.boolean(),
  /** open: not sent · sent: agent has it · addressed: agent's turn ended, awaiting verification · resolved: accepted. */
  status: ReviewCommentStatus,
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const ReviewFileView = z.object({
  filePath: z.string(),
  /** Diff signature the user saw; a different current signature means "changed since viewed". */
  signature: z.string(),
  viewedAt: z.string(),
});
export type ReviewFileView = z.infer<typeof ReviewFileView>;

export const RunReviewState = z.object({
  comments: z.array(ReviewComment),
  viewed: z.array(ReviewFileView),
  /**
   * What holds the merge gate, as core counts it: unresolved blocking comments on the run and the
   * runs it took over from by handoff, plus `carriedBlocking.count`.
   */
  blockingOpen: z.number().int().nonnegative(),
  /**
   * Blocking feedback on an earlier attempt that this run carried in its prompt, waiting for a
   * person to check it was done (POST /api/runs/:id/review/verify-carried); null when none.
   */
  carriedBlocking: z.object({ count: z.number().int().positive(), fromRun: z.string().nullable() }).nullable(),
});
export type RunReviewState = z.infer<typeof RunReviewState>;

export const CreateReviewCommentBody = z.object({
  filePath: z.string().trim().min(1).max(1024),
  /** Omitted or null makes a file-level comment. */
  line: z.number().int().min(1).nullish(),
  side: z.enum(['modified', 'original']).default('modified'),
  body: z.string().trim().min(1).max(10_000),
  intent: ReviewCommentIntent.default('fix'),
  priority: ReviewCommentPriority.default('important'),
});
export type CreateReviewCommentBody = z.input<typeof CreateReviewCommentBody>;

export const UpdateReviewCommentBody = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    status: z.enum(['open', 'resolved']),
    intent: ReviewCommentIntent,
    priority: ReviewCommentPriority,
  })
  .partial();
export type UpdateReviewCommentBody = z.input<typeof UpdateReviewCommentBody>;

/** `same`: type into (or resume) the reviewed run · `new`: start a fresh run of its ticket from main. */
export const RequestChangesTarget = z.enum(['same', 'new']);
export type RequestChangesTarget = z.infer<typeof RequestChangesTarget>;

export const RequestChangesBody = z.object({
  /** Optional overall note sent before the line comments. */
  note: z.string().trim().max(10_000).default(''),
  target: RequestChangesTarget.default('same'),
});
export type RequestChangesBody = z.input<typeof RequestChangesBody>;

/**
 * `run` is the run that got the feedback (the new one for target `new`); `sent` counts the comments
 * included. A 409 for target `same` carries `canStartNew: true` when the run can no longer take a
 * prompt but its ticket can start a new run.
 */
export interface RequestChangesResponse {
  run: Run;
  sent: number;
}

export const MarkFileViewedBody = z.object({
  filePath: z.string().trim().min(1).max(1024),
  signature: z.string().max(200),
  viewed: z.boolean(),
});
export type MarkFileViewedBody = z.input<typeof MarkFileViewedBody>;
