/**
 * ptyd RPC protocol.
 *
 * Transport: Unix domain socket, each message is a 4-byte big-endian length prefix
 * followed by a UTF-8 JSON payload (see `apps/ptyd/src/framing.ts`).
 *
 * Client -> server: {@link PtydRequest}
 * Server -> client: {@link PtydResponse} (one per request) and {@link PtydEvent} (pushed).
 */
import { z } from 'zod';

export const SessionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, 'session id may only contain letters, digits, ".", "_" and "-"');

const Cols = z.number().int().min(2).max(1000);
const Rows = z.number().int().min(2).max(500);
const StringMap = z.record(z.string(), z.string());

export const SessionInfo = z.object({
  id: SessionId,
  pid: z.number().int(),
  file: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.string(),
  status: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  /** Opaque labels set by the caller (e.g. run id). ptyd never interprets them. */
  meta: StringMap,
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ScreenSnapshot = z.object({
  /** Serialized terminal state (ANSI sequences) that recreates the screen when written to xterm.js. */
  data: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type ScreenSnapshot = z.infer<typeof ScreenSnapshot>;

const Empty = z.object({});
const BySession = z.object({ sessionId: SessionId });

export const ptydMethods = {
  spawn: {
    params: z.object({
      id: SessionId.optional(),
      file: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().min(1),
      /** Merged over a minimal base environment; ptyd does not leak its own environment. */
      env: StringMap.default({}),
      cols: Cols.default(120),
      rows: Rows.default(32),
      meta: StringMap.default({}),
    }),
    result: SessionInfo,
  },
  list: { params: Empty, result: z.object({ sessions: z.array(SessionInfo) }) },
  attach: {
    params: BySession,
    result: z.object({ session: SessionInfo, snapshot: ScreenSnapshot }),
  },
  detach: { params: BySession, result: Empty },
  write: { params: BySession.extend({ data: z.string() }), result: Empty },
  resize: { params: BySession.extend({ cols: Cols, rows: Rows }), result: Empty },
  snapshot: {
    params: BySession.extend({ scrollback: z.number().int().min(0).max(100_000).optional() }),
    result: ScreenSnapshot,
  },
  kill: { params: BySession.extend({ signal: z.string().optional() }), result: Empty },
  /** Kills the process if still running and forgets the session. */
  remove: { params: BySession, result: Empty },
} as const;

export type PtydMethod = keyof typeof ptydMethods;
export type PtydParams<M extends PtydMethod> = z.input<(typeof ptydMethods)[M]['params']>;
export type PtydParsedParams<M extends PtydMethod> = z.output<(typeof ptydMethods)[M]['params']>;
export type PtydResult<M extends PtydMethod> = z.output<(typeof ptydMethods)[M]['result']>;

export const ptydMethodNames = Object.keys(ptydMethods) as [PtydMethod, ...PtydMethod[]];

const RequestId = z.number().int().nonnegative();

export const PtydRequest = z.object({
  type: z.literal('request'),
  id: RequestId,
  method: z.enum(ptydMethodNames),
  params: z.unknown(),
});
export type PtydRequest = z.infer<typeof PtydRequest>;

export const PtydErrorCode = z.enum(['bad_request', 'not_found', 'conflict', 'internal']);
export type PtydErrorCode = z.infer<typeof PtydErrorCode>;

export const PtydResponse = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('response'), id: RequestId, ok: z.literal(true), result: z.unknown() }),
  z.object({
    type: z.literal('response'),
    id: RequestId,
    ok: z.literal(false),
    error: z.object({ code: PtydErrorCode, message: z.string() }),
  }),
]);
export type PtydResponse = z.infer<typeof PtydResponse>;

export const PtydEvent = z.discriminatedUnion('event', [
  z.object({ type: z.literal('event'), event: z.literal('output'), sessionId: SessionId, data: z.string() }),
  z.object({
    type: z.literal('event'),
    event: z.literal('exit'),
    sessionId: SessionId,
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
  }),
]);
export type PtydEvent = z.infer<typeof PtydEvent>;

export const PtydServerMessage = z.union([PtydResponse, PtydEvent]);
export type PtydServerMessage = z.infer<typeof PtydServerMessage>;
