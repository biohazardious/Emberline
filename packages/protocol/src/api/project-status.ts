/** API contracts: project status, worktree sync & interactive demo (Factory F5). */
import { z } from 'zod';
import { AgentPersona } from './projects.js';
import { RunState } from './runs.js';

/** A recorded demo build of one target (project settings `demoBuilds`, by target id). */
export const DemoBuildRecord = z.object({
  /** The workspace's HEAD when the build started; null when it could not be read (not a git repository). */
  commit: z.string().nullable(),
  /** When the build finished (ISO). */
  builtAt: z.string(),
  ok: z.boolean(),
});
export type DemoBuildRecord = z.infer<typeof DemoBuildRecord>;

export const WorkspaceDemoTarget = z.object({
  /** 'main' for /workspaces/<slug>, or the runId for a ticket run worktree. */
  id: z.string(),
  kind: z.enum(['main', 'worktree']),
  label: z.string(),
  ticketKey: z.string().nullable(),
  ticketTitle: z.string().nullable(),
  persona: AgentPersona.nullable(),
  runStatus: RunState.nullable(),
  branch: z.string().nullable(),
  workspacePath: z.string(),
  exists: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  topFiles: z.array(z.string()),
  hasPackageJson: z.boolean(),
  hasBuildScript: z.boolean(),
  /** Detected language/build stack (e.g. 'TypeScript / Node', 'Python', 'Go', 'Rust / Cargo', 'PlatformIO / ESP32', 'Shell / System CLI'). */
  detectedStack: z.string().optional(),
  /** Detected build/check command (e.g. 'pnpm run build', 'cargo check', 'go build ./...', 'pio run', 'pytest', 'bash -n'). */
  buildCommand: z.string().nullable().optional(),
  /** Architectural layers detected in the workspace (e.g. ['Frontend UI', 'Backend API', 'Database Schema']). */
  detectedLayers: z.array(z.string()).optional(),
  /** Relative path to the detected playable HTML entrypoint (e.g. 'dist/index.html', 'apps/client/dist/index.html', 'index.html'), or null if not built yet. */
  demoEntryRelPath: z.string().nullable(),
  /** Ready-to-open URL served by core, e.g. `/api/projects/:id/demo/main/` or `/api/projects/:id/demo/:runId/`. */
  demoUrl: z.string().nullable(),
  updatedAt: z.string(),
  /** The target's last recorded demo build; null when none was recorded. */
  demoBuild: DemoBuildRecord.nullable().default(null),
  /**
   * The workspace moved past the recorded build (its HEAD differs from the recorded commit), or a
   * demo is on disk that no recorded build made. False when it cannot tell (not a git repository).
   */
  demoStale: z.boolean().default(false),
  /** A build of this target is running or queued (for main also the rebuild after a merge). */
  rebuilding: z.boolean().default(false),
});
export type WorkspaceDemoTarget = z.infer<typeof WorkspaceDemoTarget>;

export const ProjectStatusSummary = z.object({
  projectId: z.string(),
  workspaceRoot: z.string(),
  hostBindHint: z.string(),
  ticketCounts: z.object({
    total: z.number().int().nonnegative(),
    backlog: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  completionPercent: z.number().int().min(0).max(100),
  activeRunCount: z.number().int().nonnegative(),
  autoChainActive: z.boolean().default(false),
  targets: z.array(WorkspaceDemoTarget),
});
export type ProjectStatusSummary = z.infer<typeof ProjectStatusSummary>;

export const SyncWorktreeBody = z.object({
  runId: z.string().min(1),
  /** Merge although the run has open blocking review comments (noted as review_blocking_overridden). */
  force: z.boolean().optional(),
});
export type SyncWorktreeBody = z.input<typeof SyncWorktreeBody>;

export const SyncWorktreeResponse = z.object({
  ok: z.boolean(),
  runId: z.string(),
  filesSynced: z.number().int().nonnegative(),
  commitSha: z.string().nullable(),
  /** Files that conflicted when the merge was refused (the main workspace is left unchanged). */
  conflicts: z.array(z.string()).default([]),
  /** The run's work was already in the main workspace: nothing was merged this time. */
  alreadyMerged: z.boolean().default(false),
  summary: z.string(),
});
export type SyncWorktreeResponse = z.infer<typeof SyncWorktreeResponse>;

export const BuildDemoBody = z.object({
  targetId: z.string().default('main'),
});
export type BuildDemoBody = z.input<typeof BuildDemoBody>;

export const BuildDemoResponse = z.object({
  ok: z.boolean(),
  targetId: z.string(),
  demoEntryRelPath: z.string().nullable(),
  demoUrl: z.string().nullable(),
  output: z.string(),
});
export type BuildDemoResponse = z.infer<typeof BuildDemoResponse>;
