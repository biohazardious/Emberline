/** API contracts: terminals. */
import { z } from 'zod';

export const TerminalKind = z.enum(['shell', 'claude', 'clone', 'agent']);
export type TerminalKind = z.infer<typeof TerminalKind>;

export const TerminalInfo = z.object({
  id: z.string(),
  title: z.string(),
  kind: TerminalKind,
  projectId: z.string().nullable(),
  /** Set when the terminal hosts an agent run. */
  runId: z.string().nullable(),
  status: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const CreateTerminalBody = z.object({
  kind: z.enum(['shell', 'claude']).default('shell'),
  projectId: z.string().optional(),
});
export type CreateTerminalBody = z.input<typeof CreateTerminalBody>;

const Cols = z.number().int().min(2).max(1000);
const Rows = z.number().int().min(2).max(500);

/** Browser -> core over `/api/terminals/:id/ws`. */
export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({ type: z.literal('resize'), cols: Cols, rows: Rows }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

/** Core -> browser. The first message is always `snapshot`. */
export const TerminalServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    data: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
    status: z.enum(['running', 'exited']),
  }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable(), signal: z.number().int().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>;
