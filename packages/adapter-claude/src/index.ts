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
import type { AgentPersona, HookEventName, HookPayload } from '@emberline/protocol';
import { rateLimitFromHook } from './ratelimit.js';

export * from './ratelimit.js';

export const CLAUDE_ADAPTER_ID = 'claude';

export interface PersonaSpec {
  id: AgentPersona;
  label: string;
  shortLabel: string;
  roleTitle: string;
  systemPrompt: string;
}

export const PERSONA_CATALOG: Record<AgentPersona, PersonaSpec> = {
  product_owner: {
    id: 'product_owner',
    label: 'Product Owner',
    shortLabel: 'PO',
    roleTitle: 'Senior Technical Product Owner & Requirements Architect',
    systemPrompt:
      'You are acting as the Senior Technical Product Owner & AI Factory Orchestrator for this project. Read PROJECT.md and inspect the codebase first. Refine user requests into clear specifications, update PROJECT.md, and delegate implementation to specialist personas (`coder` for backend/engine/logic, `ui_ux` for frontend UI/HUD/design, `dba` for database/schema, `qa` for tests & `npm run build` verification) by writing `.emberline/new-tickets.json` with `{"autoDispatch": true, "tickets": [{"title": "...", "persona": "coder|ui_ux|dba|architect|qa|security", "priority": 1..3, "body": "..."}]}`.',
  },
  architect: {
    id: 'architect',
    label: 'System Architect',
    shortLabel: 'ARCH',
    roleTitle: 'Principal Software & Systems Architect',
    systemPrompt:
      'You are acting as the Principal Systems Architect for this project. Read PROJECT.md first. Focus on clean module boundaries, API contracts, data flow, scalability, and idiomatic directory structure. You may also spawn follow-up specialist tickets by writing `.emberline/new-tickets.json`.',
  },
  ui_ux: {
    id: 'ui_ux',
    label: 'UI/UX Engineer',
    shortLabel: 'UI/UX',
    roleTitle: 'Staff Design Systems & Frontend UX Engineer',
    systemPrompt:
      'You are acting as the Staff UI/UX & Frontend Engineer for this project. Read PROJECT.md first. Focus on polished visual hierarchy, HUD/UI components, responsive layouts, accessible semantics, and cohesive styling. If `package.json` has a `build` script, run `npm run build` after your changes so the Live Demo preview updates.',
  },
  coder: {
    id: 'coder',
    label: 'Software Engineer',
    shortLabel: 'DEV',
    roleTitle: 'Senior Full-Stack Software Engineer',
    systemPrompt:
      'You are acting as the Senior Full-Stack Software Engineer for this project. Read PROJECT.md first if it exists. Write clean, production-grade, well-tested backend, engine, state, and API code that adheres to existing repository conventions. If `package.json` has a `build` script, run `npm run build` when done.',
  },
  dba: {
    id: 'dba',
    label: 'Database Architect',
    shortLabel: 'DBA',
    roleTitle: 'Principal Database & Data Layer Engineer',
    systemPrompt:
      'You are acting as the Principal Database & Data Layer Engineer for this project. Read PROJECT.md first. Focus on normalized schema design, safe reversible migrations, indexing strategy, query performance, and data integrity.',
  },
  qa: {
    id: 'qa',
    label: 'QA & Test Engineer',
    shortLabel: 'QA',
    roleTitle: 'Staff Quality Assurance & Verification Engineer',
    systemPrompt:
      'You are acting as the Staff QA & Verification Engineer for this project. Read PROJECT.md first. Focus on comprehensive unit, integration, and E2E tests, edge-case coverage, and regression prevention. Always run the test suite and `npm run build` (if present) so the production demo bundle is verified and up to date.',
  },
  security: {
    id: 'security',
    label: 'Security Engineer',
    shortLabel: 'SEC',
    roleTitle: 'Principal Application Security Engineer',
    systemPrompt:
      'You are acting as the Principal Application Security Engineer for this project. Read PROJECT.md first. Audit and harden authentication, authorization, input validation, secret handling, injection vectors, and dependency safety.',
  },
};

/**
 * Prepends role-specific instructions for non-default personas (or when explicitly requested)
 * so the CLI coding agent operates with the chosen specialist mindset.
 */
export function decoratePromptWithPersona(prompt: string | undefined, persona: AgentPersona = 'coder'): string | undefined {
  if (!prompt) return prompt;
  if (persona === 'coder') return prompt;
  const spec = PERSONA_CATALOG[persona] ?? PERSONA_CATALOG.coder;
  return `[Role: ${spec.roleTitle}]\n${spec.systemPrompt}\n\n---\nTask:\n${prompt}`;
}

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

export interface ClaudeMcpConfig {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/**
 * Builds the `--mcp-config` payload wiring headless `@playwright/mcp` so the agent can
 * navigate pages and save screenshots directly into `./artifacts` inside its worktree.
 */
export function buildPlaywrightMcpConfig(outputDir = './artifacts'): ClaudeMcpConfig {
  return {
    mcpServers: {
      playwright: {
        command: 'playwright-mcp',
        args: ['--headless', '--no-sandbox', '--output-dir', outputDir],
      },
    },
  };
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
  /** When true, passes `--mcp-config` wiring headless `@playwright/mcp`. */
  playwrightMcp?: boolean;
}

export function buildLaunchSpec(options: ClaudeLaunchOptions): LaunchSpec {
  const settings = buildHookSettings(options.hookCommand ?? 'emberline-hook');
  const args = ['--settings', JSON.stringify(settings)];
  if (options.playwrightMcp) {
    args.push('--mcp-config', JSON.stringify(buildPlaywrightMcpConfig()));
  }
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

export interface SecondaryCliLaunchOptions {
  agent: 'codex' | 'aider';
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  permissionMode?: ClaudePermissionMode;
  prompt?: string;
}

/**
 * Builds a launch spec for secondary CLI coding agents (`codex` or `aider`), wrapping
 * execution with `emberline-hook` lifecycle signals so core tracks `working` -> `done` / `failed`.
 */
export function buildSecondaryCliLaunchSpec(options: SecondaryCliLaunchOptions): LaunchSpec {
  const hook = options.hookCommand ?? 'emberline-hook';
  const autoApprove =
    options.permissionMode === 'acceptEdits' || options.permissionMode === 'bypassPermissions';

  let cliCmd: string;
  if (options.agent === 'codex') {
    const bin = process.env.EMBERLINE_CODEX_COMMAND?.trim() || 'codex';
    const flags = autoApprove ? '--full-auto ' : '';
    cliCmd = options.prompt ? `${bin} ${flags}"$EMBERLINE_PROMPT"` : `${bin} ${flags}`.trim();
  } else {
    const bin = process.env.EMBERLINE_AIDER_COMMAND?.trim() || 'aider';
    const flags = autoApprove ? '--yes-always ' : '';
    cliCmd = options.prompt
      ? `${bin} ${flags}--message "$EMBERLINE_PROMPT"`
      : `${bin} ${flags}`.trim();
  }

  const script = [
    `echo '{"session_id":"'${options.agent}-${options.runId.slice(0, 8)}'"}' | ${hook} SessionStart >/dev/null 2>&1 || true`,
    options.prompt
      ? `echo '{"prompt":"started"}' | ${hook} UserPromptSubmit >/dev/null 2>&1 || true`
      : '',
    cliCmd,
    `STATUS=$?`,
    `if [ "$STATUS" -eq 0 ]; then echo '{}' | ${hook} Stop >/dev/null 2>&1 || true; fi`,
    `exit $STATUS`,
  ]
    .filter(Boolean)
    .join('; ');

  return {
    file: 'sh',
    args: ['-c', script],
    env: {
      EMBERLINE_RUN_ID: options.runId,
      EMBERLINE_HOOK_TOKEN: options.hookToken,
      EMBERLINE_CORE_URL: options.coreUrl,
      EMBERLINE_PROMPT: options.prompt ?? '',
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
