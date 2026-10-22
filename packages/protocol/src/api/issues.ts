/** API contracts: importing forge issues (GitHub / GitLab / Gitea) as tickets. */
import { z } from 'zod';
import { ForgeProvider } from './forge.js';
import { Ticket } from './tickets.js';

export const ForgeIssueState = z.enum(['open', 'closed']);
export type ForgeIssueState = z.infer<typeof ForgeIssueState>;

/** An issue normalised across providers. `externalId` is the provider's stable id, `number` the visible #n (GitLab iid). */
export const ForgeIssue = z.object({
  externalId: z.string(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  url: z.string(),
  author: z.string().nullable(),
  updatedAt: z.string(),
  state: ForgeIssueState,
});
export type ForgeIssue = z.infer<typeof ForgeIssue>;

export const ForgeIssueListItem = ForgeIssue.omit({ body: true }).extend({
  /** Key of the ticket this issue was already imported as, if any. */
  linkedTicketKey: z.string().nullable(),
});
export type ForgeIssueListItem = z.infer<typeof ForgeIssueListItem>;

export const ForgeIssueListQuery = z.object({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  labels: z.string().trim().max(500).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type ForgeIssueListQuery = z.input<typeof ForgeIssueListQuery>;

export const ForgeIssueListResponse = z.object({
  provider: ForgeProvider,
  items: z.array(ForgeIssueListItem),
  nextPage: z.number().int().nullable(),
});
export type ForgeIssueListResponse = z.infer<typeof ForgeIssueListResponse>;

export const ImportIssuesBody = z.object({
  /** The selected issues: the provider id plus the visible number core re-fetches them by. */
  issues: z
    .array(z.object({ externalId: z.string().min(1).max(100), number: z.number().int().min(1) }))
    .min(1)
    .max(50),
  status: z.enum(['backlog', 'ready']).default('backlog'),
});
export type ImportIssuesBody = z.input<typeof ImportIssuesBody>;

export const ImportIssuesResponse = z.object({
  created: z.array(Ticket),
  existing: z.array(Ticket),
  /** Selected issues core did not import, e.g. gone from the forge or not matching the id. */
  skipped: z.array(z.object({ externalId: z.string(), reason: z.string() })),
});
export type ImportIssuesResponse = z.infer<typeof ImportIssuesResponse>;

/** The repository label sync works on: pinned when sync is enabled (or on its first sync). */
export const IssueSyncRepo = z.object({ provider: ForgeProvider, repoPath: z.string().min(1).max(500) });
export type IssueSyncRepo = z.infer<typeof IssueSyncRepo>;

const IssueSyncSettingsObject = z.object({
  enabled: z.boolean().default(false),
  /** The issue label that pulls an issue in; required when sync is enabled. */
  label: z.string().trim().max(100).default(''),
  status: z.enum(['backlog', 'ready']).default('backlog'),
  closeOnDone: z.boolean().default(false),
  commentOnProgress: z.boolean().default(true),
  /**
   * Issue authors (usernames) whose issues label sync may put straight into `status`. Label sync
   * imports from anyone else always land in `backlog`. A manual import keeps the status the
   * person chose.
   */
  trustedAuthors: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  /**
   * Set by core, never by the PATCH body: the repository origin named when sync was enabled. Label
   * sync refuses to run (lastError) once origin names another one; disabling and enabling re-pins.
   */
  repo: IssueSyncRepo.nullable().default(null),
});

export const IssueSyncSettings = IssueSyncSettingsObject.superRefine((v, ctx) => {
  if (v.enabled && !v.label) {
    ctx.addIssue({
      code: 'custom',
      path: ['label'],
      message: 'a label is required when issue sync is enabled',
    });
  }
});
export type IssueSyncSettings = z.infer<typeof IssueSyncSettings>;

/** What the label sync last did for a project (kept in memory: empty after a restart). */
export const IssueSyncStatus = z.object({
  /** ISO time of the last sync that reached the forge (a 304 counts). */
  lastSyncAt: z.string().nullable(),
  /** Why the last sync of this project failed; null after a good one. */
  lastError: z.string().nullable(),
  /** ISO time until which all forge sync is paused by the rate limit. */
  pausedUntil: z.string().nullable(),
});
export type IssueSyncStatus = z.infer<typeof IssueSyncStatus>;

/**
 * GET / PATCH /api/projects/:id/issue-sync: the settings plus the sync status (`syncStatus`, as
 * `status` is the settings' target column).
 */
export const IssueSyncResponse = IssueSyncSettingsObject.extend({ syncStatus: IssueSyncStatus });
export type IssueSyncResponse = z.infer<typeof IssueSyncResponse>;

/** PATCH body: any subset of the settings; the merged result must be valid. */
export const UpdateIssueSyncBody = z
  .object({
    enabled: z.boolean(),
    label: z.string().trim().max(100),
    status: z.enum(['backlog', 'ready']),
    closeOnDone: z.boolean(),
    commentOnProgress: z.boolean(),
    trustedAuthors: z.array(z.string().trim().min(1).max(100)).max(50),
  })
  .partial();
export type UpdateIssueSyncBody = z.input<typeof UpdateIssueSyncBody>;
