/** API contracts: review: git diff, commit/push & artifacts (M6). */
import { z } from 'zod';

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
});
export type RunBuildOutputsResponse = z.infer<typeof RunBuildOutputsResponse>;

export const PruneWorktreeBody = z.object({
  /** Remove the worktree even when it holds uncommitted changes or commits not in the default branch. */
  force: z.boolean().default(false),
});
export type PruneWorktreeBody = z.input<typeof PruneWorktreeBody>;

export const PruneWorktreeResponse = z.object({
  runId: z.string(),
  worktreePath: z.string(),
  removed: z.boolean(),
});
export type PruneWorktreeResponse = z.infer<typeof PruneWorktreeResponse>;

// --- persistent code review (Phase 4) ---------------------------------------

export const ReviewCommentStatus = z.enum(['open', 'sent', 'resolved']);
export type ReviewCommentStatus = z.infer<typeof ReviewCommentStatus>;

export const ReviewComment = z.object({
  id: z.string(),
  runId: z.string(),
  filePath: z.string(),
  line: z.number().int(),
  side: z.enum(['modified', 'original']),
  body: z.string(),
  /** open: not sent yet · sent: included in a "request changes" prompt · resolved: done. */
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
});
export type RunReviewState = z.infer<typeof RunReviewState>;

export const CreateReviewCommentBody = z.object({
  filePath: z.string().trim().min(1).max(1024),
  line: z.number().int().min(1),
  side: z.enum(['modified', 'original']).default('modified'),
  body: z.string().trim().min(1).max(10_000),
});
export type CreateReviewCommentBody = z.input<typeof CreateReviewCommentBody>;

export const UpdateReviewCommentBody = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    status: z.enum(['open', 'resolved']),
  })
  .partial();
export type UpdateReviewCommentBody = z.input<typeof UpdateReviewCommentBody>;

export const RequestChangesBody = z.object({
  /** Optional overall note sent before the line comments. */
  note: z.string().trim().max(10_000).default(''),
});
export type RequestChangesBody = z.input<typeof RequestChangesBody>;

export const MarkFileViewedBody = z.object({
  filePath: z.string().trim().min(1).max(1024),
  signature: z.string().max(200),
  viewed: z.boolean(),
});
export type MarkFileViewedBody = z.input<typeof MarkFileViewedBody>;
