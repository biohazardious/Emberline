/** API contracts: autonomous factory orchestrator & agent self-task creation (Factory F6). */
import { z } from 'zod';
import { AgentPersona, PermissionMode } from './projects.js';
import { AgentId, AgentModelId, Run } from './runs.js';
import { Ticket, TicketPriority } from './tickets.js';

export const AgentTicketDraft = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  persona: AgentPersona.default('coder'),
  priority: TicketPriority.default(2),
  preferredAgent: AgentId.optional(),
  preferredModel: AgentModelId.optional(),
  /** Batch-local handle other drafts can name in `dependsOn`. */
  ref: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/))
    .optional(),
  /** Refs of drafts in the batch, or keys of existing tickets of the project. */
  dependsOn: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
});
export type AgentTicketDraft = z.infer<typeof AgentTicketDraft>;

export const AgentCreateTicketsPayload = z.object({
  autoDispatch: z.boolean().default(true),
  tickets: z.array(AgentTicketDraft).min(1).max(20),
});
export type AgentCreateTicketsPayload = z.input<typeof AgentCreateTicketsPayload>;

export const FactoryAttachmentInput = z.object({
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().max(150).default('application/octet-stream'),
  /** Base64-encoded file bytes (or data URL). */
  dataBase64: z.string().min(1).max(25_000_000),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type FactoryAttachmentInput = z.infer<typeof FactoryAttachmentInput>;

export const FactoryRequestBody = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  leadPersona: AgentPersona.default('product_owner'),
  permissionMode: PermissionMode.default('auto'),
  autoDispatch: z.boolean().default(true),
  attachments: z.array(FactoryAttachmentInput).max(10).optional(),
});
export type FactoryRequestBody = z.input<typeof FactoryRequestBody>;

export const FactoryRequestResponse = z.object({
  ticket: Ticket,
  run: Run,
});
export type FactoryRequestResponse = z.infer<typeof FactoryRequestResponse>;
