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
  externalIds: z.array(z.string().min(1).max(100)).min(1).max(50),
  status: z.enum(['backlog', 'ready']).default('backlog'),
});
export type ImportIssuesBody = z.input<typeof ImportIssuesBody>;

export const ImportIssuesResponse = z.object({
  created: z.array(Ticket),
  existing: z.array(Ticket),
});
export type ImportIssuesResponse = z.infer<typeof ImportIssuesResponse>;

export const IssueSyncSettings = z
  .object({
    enabled: z.boolean().default(false),
    /** The issue label that pulls an issue in; required when sync is enabled. */
    label: z.string().trim().max(100).default(''),
    status: z.enum(['backlog', 'ready']).default('backlog'),
    closeOnDone: z.boolean().default(false),
    commentOnProgress: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && !v.label) {
      ctx.addIssue({ code: 'custom', path: ['label'], message: 'a label is required when issue sync is enabled' });
    }
  });
export type IssueSyncSettings = z.infer<typeof IssueSyncSettings>;
