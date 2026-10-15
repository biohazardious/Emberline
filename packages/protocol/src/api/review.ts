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

export const PruneWorktreeResponse = z.object({
  runId: z.string(),
  worktreePath: z.string(),
  removed: z.boolean(),
});
export type PruneWorktreeResponse = z.infer<typeof PruneWorktreeResponse>;
