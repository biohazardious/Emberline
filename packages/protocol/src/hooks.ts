/**
 * Claude Code hook events as forwarded by `emberline-hook` to core.
 *
 * Claude delivers a JSON payload on the hook command's stdin. Only the common fields are
 * modelled; everything else is kept (loose object) because the payload shape evolves
 * between CLI releases.
 */
import { z } from 'zod';

export const HookEventName = z.enum([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  /** Replaces `Stop` when the turn ended on an API error; `error` is e.g. `rate_limit`. */
  'StopFailure',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
]);
export type HookEventName = z.infer<typeof HookEventName>;

export const HookPayload = z.looseObject({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

/** Body of `POST /api/internal/hooks`. */
export const HookEnvelope = z.object({
  runId: z.string().min(1),
  event: HookEventName,
  receivedAt: z.string(),
  payload: HookPayload,
});
export type HookEnvelope = z.infer<typeof HookEnvelope>;
