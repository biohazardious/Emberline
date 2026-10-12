/**
 * Claude Code adapter. The full {@link AgentAdapter} implementation lands in M3;
 * this module currently provides the hook wiring used by every run.
 */
import type { HookEventName } from '@emberline/protocol';

export const CLAUDE_ADAPTER_ID = 'claude';

/** Hooks Emberline listens to for state detection (PROJECT.md §3.3). */
export const WATCHED_HOOKS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
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
 * Builds the settings object passed to `claude --settings <file>` for a run.
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
