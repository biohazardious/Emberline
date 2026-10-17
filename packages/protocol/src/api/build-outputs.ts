/** API contracts: archived run build outputs (APKs, installers, firmware). */
import { z } from 'zod';
import { AgentPersona } from './projects.js';

export const ProjectBuildOutput = z.object({
  id: z.string(),
  name: z.string(),
  sizeBytes: z.number().int().min(0),
  archivedAt: z.string(),
  sourceMtime: z.string(),
  pinned: z.boolean(),
  runId: z.string(),
  /** False once the run row was removed (its outputs are kept on purpose). */
  runExists: z.boolean(),
  ticketId: z.string().nullable(),
  ticketKey: z.string().nullable(),
  ticketTitle: z.string().nullable(),
  persona: AgentPersona.nullable(),
  agent: z.string().nullable(),
  /** Where the file sits on the host, through the workspaces host mapping; null when core does not know it. */
  hostPath: z.string().nullable(),
  /** Where the file sits inside core's and the runner's containers (`/workspaces/...`). */
  containerPath: z.string(),
});
export type ProjectBuildOutput = z.infer<typeof ProjectBuildOutput>;

export const CollectCounts = z.object({
  archived: z.number().int().min(0),
  skipped: z.number().int().min(0),
  failed: z.number().int().min(0),
});

export const ProjectBuildOutputsResponse = z.object({
  /** A "collect now" pass is running for the project. */
  collecting: z.boolean(),
  /** The last finished collect since core started. */
  lastCollect: CollectCounts.extend({ finishedAt: z.string() }).nullable(),
  quotaBytes: z.number().min(0),
  usedBytes: z.number().min(0),
  /** The project's archive directory on the host; null without the workspaces host mapping. */
  hostArchiveDir: z.string().nullable(),
  /** The same directory inside the containers. */
  archiveDir: z.string(),
  /** With `?run=`: that run and the rest of its handoff chain (their outputs match the run filter). */
  runChain: z.array(z.string()).nullable(),
  /** Newest first. */
  outputs: z.array(ProjectBuildOutput),
});
export type ProjectBuildOutputsResponse = z.infer<typeof ProjectBuildOutputsResponse>;

export const UpdateBuildOutputBody = z.object({ pinned: z.boolean() });
export type UpdateBuildOutputBody = z.infer<typeof UpdateBuildOutputBody>;

/** Collect runs in the background: `started` for a new pass, `running` when one already was. */
export const CollectBuildOutputsResponse = z.object({ status: z.enum(['started', 'running']) });
export type CollectBuildOutputsResponse = z.infer<typeof CollectBuildOutputsResponse>;
