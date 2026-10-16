/** API contracts: autonomous factory orchestrator & agent self-task creation (Factory F6). */
import { z } from 'zod';
import { AgentPersona, PermissionMode } from './projects.js';
import { AgentId, AgentModelId, Run } from './runs.js';
import { Ticket, TicketPriority } from './tickets.js';

/**
 * A draft `ref` in its stored form: lowercase letters, digits and hyphens, starting with a letter
 * or digit, at most 40 characters. Anything else is rewritten to fit; undefined when nothing is left.
 */
export function normalizeTicketRef(value: unknown): string | undefined {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string') return undefined;
  const ref = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 40);
  return ref || undefined;
}

/** One malformed `ref` must not cost the PO its whole batch: it is normalized or dropped. */
const DraftRef = z.preprocess(normalizeTicketRef, z.string().optional()).catch(undefined).optional();

/** A single string becomes a list, numbers become strings, other entries are dropped, at most 10 kept. */
const DraftDependsOn = z
  .preprocess((value) => {
    const list = typeof value === 'string' || typeof value === 'number' ? [value] : value;
    if (!Array.isArray(list)) return undefined;
    return list
      .map((entry) => (typeof entry === 'number' && Number.isFinite(entry) ? String(entry) : entry))
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry.length <= 60)
      .slice(0, 10);
  }, z.array(z.string()).optional())
  .catch(undefined)
  .optional();

export const AgentTicketDraft = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  persona: AgentPersona.default('coder'),
  priority: TicketPriority.default(2),
  preferredAgent: AgentId.optional(),
  preferredModel: AgentModelId.optional(),
  /** Batch-local handle other drafts can name in `dependsOn`. */
  ref: DraftRef,
  /** Refs of drafts in the batch, or keys of existing tickets of the project. */
  dependsOn: DraftDependsOn,
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
