/** API contracts: update tracking for Emberline itself, the agent CLIs and MCP servers. */
import { z } from 'zod';
import { AgentId } from './runs.js';

export const UpdateItemKind = z.enum(['emberline', 'cli', 'mcp', 'bundled']);
export type UpdateItemKind = z.infer<typeof UpdateItemKind>;

export const UpdateItemState = z.enum([
  'up_to_date',
  'update_available',
  'not_installed',
  /** Pinned to a version on purpose (MCP `pkg@1.2.3`); never offered an update. */
  'pinned',
  /** Ships with the Emberline image; updated by updating Emberline. */
  'bundled',
  /** No public source for the latest version (e.g. Antigravity). */
  'unknown',
  'error',
]);
export type UpdateItemState = z.infer<typeof UpdateItemState>;

export const UpdateItem = z.object({
  id: z.string(),
  kind: UpdateItemKind,
  name: z.string(),
  installed: z.string().nullable(),
  latest: z.string().nullable(),
  state: UpdateItemState,
  /** Why the state is what it is (an error, "checked without a token", ...). */
  note: z.string().nullable().default(null),
  /** For CLIs: the provider to update through the toolchain. */
  provider: AgentId.nullable().default(null),
  /** For MCP servers run through npx: its id, to refresh the cached copy. */
  mcpId: z.string().nullable().default(null),
});
export type UpdateItem = z.infer<typeof UpdateItem>;

export const EmberlineRelease = z.object({
  version: z.string(),
  url: z.string(),
  notes: z.string(),
  publishedAt: z.string().nullable(),
});
export type EmberlineRelease = z.infer<typeof EmberlineRelease>;

export const UpdateStatus = z.object({
  checkedAt: z.string().nullable(),
  currentVersion: z.string(),
  /** The newest release when it is newer than the running version. */
  release: EmberlineRelease.nullable(),
  items: z.array(UpdateItem),
  /** Number of items with an update available, for the badge next to the version. */
  available: z.number().int().nonnegative(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export const UpdateConfigView = z.object({
  autoCheck: z.boolean(),
  /** A GitHub token is stored (write-only); needed while the repository is private. */
  tokenConfigured: z.boolean(),
});
export type UpdateConfigView = z.infer<typeof UpdateConfigView>;

export const UpdatesResponse = z.object({ config: UpdateConfigView, status: UpdateStatus });
export type UpdatesResponse = z.infer<typeof UpdatesResponse>;

export const UpdateConfigBody = z.object({
  autoCheck: z.boolean().optional(),
  /** A new token, or null to remove it. Omitted keeps the stored one. */
  githubToken: z.string().trim().max(500).nullable().optional(),
});
export type UpdateConfigBody = z.input<typeof UpdateConfigBody>;
