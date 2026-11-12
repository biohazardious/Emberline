import type { AgentState } from './index.js';
import type { HookPayloadLike } from './limits.js';

/**
 * Whether a Notification hook payload is a permission prompt ("a human must act now") rather than an
 * idle reminder. Shared by the Claude adapter (state) and core (attention reason).
 */
export function isPermissionNotification(payload: HookPayloadLike): boolean {
  const type = typeof payload.notification_type === 'string' ? payload.notification_type : undefined;
  if (type) return type === 'permission_prompt';
  const message = typeof payload.message === 'string' ? payload.message : '';
  return /permission/i.test(message);
}

/** What a CLI's own wording decides inside the shared hook state machine. */
export interface HookStateRules {
  /** The `Stop` / `StopFailure` hook reports a usage limit. */
  isRateLimit(event: string, payload: HookPayloadLike): boolean;
  /** A `Notification` saying the CLI itself is waiting out a usage limit. */
  isQuotaWait?(payload: HookPayloadLike): boolean;
}

/**
 * Derives the next agent state from a hook. Returns `undefined` when the state is unchanged.
 * Claude Code sends these events itself; every other CLI's wrapper script sends the same names.
 *
 * - SessionStart: interactive session is up and idle until a prompt arrives.
 * - UserPromptSubmit / Pre/PostToolUse: the agent is working.
 * - Notification: permission prompts always need the user; idle reminders only matter while
 *   the agent has not finished (after `Stop` the run is already `done`) or hit a limit.
 * - Stop / SessionEnd: turn or session finished.
 * - StopFailure: the turn died on an error. A usage limit -> `rate_limited` (the scheduler
 *   resumes it); anything else needs the user.
 */
export function nextStateFromHookWith(
  rules: HookStateRules,
  current: AgentState,
  event: string,
  payload: HookPayloadLike = {},
): AgentState | undefined {
  if (current === 'failed') return undefined;
  let next: AgentState | undefined;
  switch (event) {
    case 'SessionStart':
      // A fresh session waits for its prompt. Mid-run, `resume` (the CLI relaunched itself, e.g.
      // after a renderer switch) and `clear` drop any turn in flight: the agent is back at an empty
      // prompt. `compact` happens inside a turn, which keeps going.
      if (current === 'starting') next = 'waiting_input';
      else if (payload.source === 'resume' || payload.source === 'clear') next = 'waiting_input';
      else next = undefined;
      break;
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      next = 'working';
      break;
    case 'Notification':
      if (rules.isQuotaWait?.(payload)) next = current === 'done' ? undefined : 'rate_limited';
      else if (isPermissionNotification(payload)) next = 'waiting_input';
      else next = current === 'done' || current === 'rate_limited' ? undefined : 'waiting_input';
      break;
    case 'Stop':
      next = rules.isRateLimit(event, payload) ? 'rate_limited' : 'done';
      break;
    case 'StopFailure':
      next = rules.isRateLimit(event, payload) ? 'rate_limited' : 'waiting_input';
      break;
    case 'SessionEnd':
      next = current === 'rate_limited' ? undefined : 'done';
      break;
    default:
      next = undefined;
  }
  return next === current ? undefined : next;
}

/** State after the PTY process exited (hooks may not have fired, e.g. on a crash). */
export function stateAfterExit(current: AgentState, exitCode: number | null): AgentState {
  // A rate-limited run whose process went away stays rate-limited: it resumes via its resume flag.
  if (current === 'done' || current === 'failed' || current === 'rate_limited') return current;
  return exitCode === 0 ? 'done' : 'failed';
}
