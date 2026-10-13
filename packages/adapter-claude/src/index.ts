/**
 * Claude Code adapter.
 *
 * Pure building blocks used by core's run service:
 * - {@link buildHookSettings}: the `--settings` object wiring every hook to `emberline-hook`.
 * - {@link buildLaunchSpec}: the full command line + env for a run.
 * - {@link nextStateFromHook}: the hook -> {@link AgentState} state machine (PROJECT.md §3.3).
 *
 * Rate-limit detection and reset-time parsing live in ./ratelimit.ts, behind fixture tests.
 */
import type { AgentState, LaunchSpec } from '@emberline/adapter-sdk';
import type { HookEventName, HookPayload } from '@emberline/protocol';
import { rateLimitFromHook } from './ratelimit.js';

export * from './ratelimit.js';

export const CLAUDE_ADAPTER_ID = 'claude';

/** Hooks Emberline listens to for state detection (PROJECT.md §3.3). */
export const WATCHED_HOOKS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ClaudeHookSettings {
  hooks: Partial<Record<HookEventName, HookMatcherGroup[]>>;
}

/** Tool events require a matcher; an empty string matches every tool. */
const MATCHER_EVENTS = new Set<HookEventName>(['PreToolUse', 'PostToolUse']);

/**
 * Builds the settings object passed to `claude --settings <json>` for a run.
 * Every watched hook invokes `<hookCommand> <EventName>`; the run id travels via env.
 */
export function buildHookSettings(hookCommand: string, timeoutSeconds = 5): ClaudeHookSettings {
  const hooks: ClaudeHookSettings['hooks'] = {};
  for (const event of WATCHED_HOOKS) {
    const group: HookMatcherGroup = {
      hooks: [{ type: 'command', command: `${hookCommand} ${event}`, timeout: timeoutSeconds }],
    };
    if (MATCHER_EVENTS.has(event)) group.matcher = '';
    hooks[event] = [group];
  }
  return { hooks };
}

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface ClaudeLaunchOptions {
  runId: string;
  /** Per-run secret the hook presents to core. */
  hookToken: string;
  /** Base URL of core as reachable from the runner. */
  coreUrl: string;
  /** Executable names/paths inside the runner. */
  claudeCommand?: string;
  hookCommand?: string;
  permissionMode?: ClaudePermissionMode;
  /** Initial prompt; empty starts an idle interactive session. */
  prompt?: string;
  /** Claude session id to continue (`--resume`). */
  resumeSessionId?: string;
}

export function buildLaunchSpec(options: ClaudeLaunchOptions): LaunchSpec {
  const settings = buildHookSettings(options.hookCommand ?? 'emberline-hook');
  const args = ['--settings', JSON.stringify(settings)];
  if (options.permissionMode && options.permissionMode !== 'default') {
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  // `--` ends option parsing so a prompt starting with "-" is never read as a flag.
  if (options.prompt) args.push('--', options.prompt);
  return {
    file: options.claudeCommand ?? 'claude',
    args,
    env: {
      EMBERLINE_RUN_ID: options.runId,
      EMBERLINE_HOOK_TOKEN: options.hookToken,
      EMBERLINE_CORE_URL: options.coreUrl,
      DISABLE_AUTOUPDATER: '1',
    },
  };
}

/** Notification hooks that mean "a human must act now" rather than "idle for a while". */
function isPermissionNotification(payload: HookPayload): boolean {
  const type = typeof payload.notification_type === 'string' ? payload.notification_type : undefined;
  if (type) return type === 'permission_prompt';
  const message = typeof payload.message === 'string' ? payload.message : '';
  return /permission/i.test(message);
}

/**
 * Derives the next agent state from a hook. Returns `undefined` when the state is unchanged.
 *
 * - SessionStart: interactive session is up and idle until a prompt arrives.
 * - UserPromptSubmit / Pre/PostToolUse: the agent is working.
 * - Notification: permission prompts always need the user; idle reminders only matter while
 *   the agent has not finished (after `Stop` the run is already `done`) or hit a limit.
 * - Stop / SessionEnd: turn or session finished.
 * - StopFailure: the turn died on an API error. `rate_limit` -> `rate_limited` (the scheduler
 *   resumes it); anything else needs the user.
 */
export function nextStateFromHook(
  current: AgentState,
  event: HookEventName,
  payload: HookPayload = {},
): AgentState | undefined {
  if (current === 'failed') return undefined;
  let next: AgentState | undefined;
  switch (event) {
    case 'SessionStart':
      next = current === 'starting' ? 'waiting_input' : undefined;
      break;
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      next = 'working';
      break;
    case 'Notification':
      if (isPermissionNotification(payload)) next = 'waiting_input';
      else next = current === 'done' || current === 'rate_limited' ? undefined : 'waiting_input';
      break;
    case 'Stop':
      next = rateLimitFromHook(event, payload) ? 'rate_limited' : 'done';
      break;
    case 'StopFailure':
      next = rateLimitFromHook(event, payload) ? 'rate_limited' : 'waiting_input';
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
  // A rate-limited run whose process went away stays rate-limited: it resumes via --resume.
  if (current === 'done' || current === 'failed' || current === 'rate_limited') return current;
  return exitCode === 0 ? 'done' : 'failed';
}

/** Prompt typed into a session to pick up after a limit reset. */
export const CONTINUE_PROMPT = 'Continue where you left off.';
