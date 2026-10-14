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

export const AUTONOMOUS_EXECUTION_POLICY =
  'AUTONOMOUS EXECUTION MODE: You are running unattended inside the Emberline AI Coding Factory. Never ask the user clarifying questions, never pause for confirmation, and never ask whether to commit or open a PR (Emberline automatically syncs and commits your worktree when your turn finishes). When multiple implementation choices exist (e.g. localStorage vs external backend/database), choose the simplest self-contained local option that satisfies PROJECT.md, state your choice briefly, and complete the entire task in this turn.';

export const AUTONOMOUS_ALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'mcp__playwright__*',
] as const;

export const PERSONA_CATALOG: Record<AgentPersona, PersonaSpec> = {
  product_owner: {
    id: 'product_owner',
    label: 'Product Owner',
    shortLabel: 'PO',
    roleTitle: 'Senior Technical Product Owner & Requirements Architect',
    systemPrompt:
      'You are acting as the Senior Technical Product Owner & AI Factory Orchestrator for this project. Read PROJECT.md and inspect the codebase first. Refine user requests into clear specifications, update PROJECT.md, and delegate implementation to specialist personas (`coder` for backend/engine/logic, `ui_ux` for frontend UI/HUD/design, `dba` for database/schema, `qa` for tests & `npm run build` verification) by writing `.emberline/new-tickets.json` with `{"autoDispatch": true, "tickets": [{"title": "...", "persona": "coder|ui_ux|dba|architect|qa|security", "priority": 1..3, "body": "..."}]}`. Do NOT ask clarifying questions—choose pragmatic self-contained defaults and write `.emberline/new-tickets.json` in this turn.',
  },
  architect: {
    id: 'architect',
    label: 'System Architect',
    shortLabel: 'ARCH',
    roleTitle: 'Principal Software & Systems Architect',
    systemPrompt:
      'You are acting as the Principal Systems Architect for this project. Read PROJECT.md first. Focus on clean module boundaries, API contracts, data flow, scalability, and idiomatic directory structure. You may also spawn follow-up specialist tickets by writing `.emberline/new-tickets.json`. Execute autonomously without asking clarifying questions.',
  },
  ui_ux: {
    id: 'ui_ux',
    label: 'UI/UX Engineer',
    shortLabel: 'UI/UX',
    roleTitle: 'Staff Design Systems & Frontend UX Engineer',
    systemPrompt:
      'You are acting as the Staff UI/UX & Frontend Engineer for this project. Read PROJECT.md first. Focus on polished visual hierarchy, HUD/UI components, responsive layouts, accessible semantics, and cohesive styling. If `package.json` has a `build` script, run `npm run build` after your changes so the Live Demo preview updates, and if `$EMBERLINE_DEMO_URL` is set, open `$EMBERLINE_DEMO_URL` with `mcp__playwright__browser_navigate` and `mcp__playwright__browser_snapshot` so your work is visible in the Live Browser. Execute autonomously without asking whether to commit.',
  },
  coder: {
    id: 'coder',
    label: 'Software Engineer',
    shortLabel: 'DEV',
    roleTitle: 'Senior Full-Stack Software Engineer',
    systemPrompt:
      'You are acting as the Senior Full-Stack Software Engineer for this project. Read PROJECT.md first if it exists. Write clean, production-grade, well-tested backend, engine, state, and API code that adheres to existing repository conventions. If `package.json` has a `build` script, run `npm run build` when done. Execute autonomously without asking clarifying questions or asking whether to commit.',
  },
  dba: {
    id: 'dba',
    label: 'Database Architect',
    shortLabel: 'DBA',
    roleTitle: 'Principal Database & Data Layer Engineer',
    systemPrompt:
      'You are acting as the Principal Database & Data Layer Engineer for this project. Read PROJECT.md first. Focus on normalized schema design, safe reversible migrations, indexing strategy, query performance, and data integrity. Execute autonomously without asking clarifying questions.',
  },
  qa: {
    id: 'qa',
    label: 'QA & Test Engineer',
    shortLabel: 'QA',
    roleTitle: 'Staff Quality Assurance & Verification Engineer',
    systemPrompt:
      'You are acting as the Staff QA & Verification Engineer for this project. Read PROJECT.md first. Focus on comprehensive unit, integration, and E2E tests, edge-case coverage, and regression prevention. Always run the test suite and `npm run build` (if present) so the production demo bundle is verified and up to date, then open `$EMBERLINE_DEMO_URL` using `mcp__playwright__browser_navigate`, interact with the app via `mcp__playwright__browser_click` / `mcp__playwright__browser_snapshot`, and verify there are no console errors in the Live Browser. Execute autonomously without asking whether to commit.',
  },
  security: {
    id: 'security',
    label: 'Security Engineer',
    shortLabel: 'SEC',
    roleTitle: 'Principal Application Security Engineer',
    systemPrompt:
      'You are acting as the Principal Application Security Engineer for this project. Read PROJECT.md first. Audit and harden authentication, authorization, input validation, secret handling, injection vectors, and dependency safety. Execute autonomously without asking clarifying questions.',
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
  permissions?: {
    defaultMode?: 'auto' | 'acceptEdits' | 'bypassPermissions';
    allow?: string[];
  };
}

/** Tool events require a matcher; an empty string matches every tool. */
const MATCHER_EVENTS = new Set<HookEventName>(['PreToolUse', 'PostToolUse']);

/**
 * Builds the settings object passed to `claude --settings <json>` for a run.
 * Every watched hook invokes `<hookCommand> <EventName>`; the run id travels via env.
 * When `autonomous` is enabled, pre-allows Bash/Edit/Write tools and sets `defaultMode: 'auto'`.
 */
export function buildHookSettings(hookCommand: string, timeoutSeconds = 5, autonomous = false): ClaudeHookSettings {
  const hooks: ClaudeHookSettings['hooks'] = {};
  for (const event of WATCHED_HOOKS) {
    const group: HookMatcherGroup = {
      hooks: [{ type: 'command', command: `${hookCommand} ${event}`, timeout: timeoutSeconds }],
    };
    if (MATCHER_EVENTS.has(event)) group.matcher = '';
    hooks[event] = [group];
  }
  if (autonomous) {
    return {
      hooks,
      permissions: {
        defaultMode: 'auto',
        allow: [...AUTONOMOUS_ALLOWED_TOOLS],
      },
    };
  }
  return { hooks };
}

export interface ClaudeMcpConfig {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/**
 * Builds the `--mcp-config` payload wiring `@playwright/mcp` to the shared CDP Chromium
 * instance (`http://127.0.0.1:9222`) inside the runner so the user can watch and interact
 * with the agent's browser in real time from the Emberline Live Browser view.
 */
export function buildPlaywrightMcpConfig(
  outputDir = './artifacts',
  cdpEndpoint = 'http://127.0.0.1:9222',
): ClaudeMcpConfig {
  return {
    mcpServers: {
      playwright: {
        command: 'playwright-mcp',
        args: ['--cdp-endpoint', cdpEndpoint, '--output-dir', outputDir],
      },
    },
  };
}

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';

export type ClaudeModelTier =
  | 'auto'
  | 'fable'
  | 'opus'
  | 'sonnet'
  | 'haiku'
  | 'argon'
  | 'gemini-pro'
  | 'gemini-flash'
  | 'gemini-flash-lite'
  | 'o3'
  | 'gpt-4o'
  | 'o4-mini'
  | 'gpt-4o-mini';

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
  /** Optional model tier (fable, opus, sonnet, haiku, etc.). */
  model?: ClaudeModelTier;
  /**
   * When true, starts the session in unattended `auto` mode with pre-authorized
   * Bash/Edit/Write permissions and appends the autonomous non-interactive system prompt.
   */
  autonomous?: boolean;
  /** Initial prompt; empty starts an idle interactive session. */
  prompt?: string;
  /** Claude session id to continue (`--resume`). */
  resumeSessionId?: string;
  /** When true, passes `--mcp-config` wiring headless `@playwright/mcp`. */
  playwrightMcp?: boolean;
}

export function resolveClaudeCliModelFlag(model?: ClaudeModelTier): string | undefined {
  if (!model || model === 'auto') return undefined;
  if (model === 'fable' || model === 'opus' || model === 'o3') return 'opus';
  if (
    model === 'sonnet' ||
    model === 'argon' ||
    model === 'gemini-pro' ||
    model === 'gemini-flash' ||
    model === 'gpt-4o' ||
    model === 'o4-mini'
  ) {
    return 'sonnet';
  }
  if (model === 'haiku' || model === 'gemini-flash-lite' || model === 'gpt-4o-mini') return 'haiku';
  return undefined;
}

export function buildLaunchSpec(options: ClaudeLaunchOptions): LaunchSpec {
  const isAutonomous = Boolean(options.autonomous && options.permissionMode !== 'plan');
  const settings = buildHookSettings(options.hookCommand ?? 'emberline-hook', 5, isAutonomous);
  const args = ['--settings', JSON.stringify(settings)];
  if (options.playwrightMcp) {
    args.push('--mcp-config', JSON.stringify(buildPlaywrightMcpConfig()));
  }
  const cliModel = resolveClaudeCliModelFlag(options.model);
  if (cliModel) {
    args.push('--model', cliModel);
  }
  if (isAutonomous) {
    const cliMode = options.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'auto';
    args.push('--permission-mode', cliMode);
    const extraPolicy =
      options.model === 'fable'
        ? `${AUTONOMOUS_EXECUTION_POLICY}\n[FABLE DEEP-ANALYSIS MODE: Perform deep architectural synthesis, edge-case analysis, and root-cause verification before writing code.]`
        : AUTONOMOUS_EXECUTION_POLICY;
    args.push('--append-system-prompt', extraPolicy);
  } else if (options.permissionMode && options.permissionMode !== 'default') {
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
  agent: 'antigravity' | 'copilot' | 'gemini' | 'codex' | 'aider';
  model?: ClaudeModelTier;
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  permissionMode?: ClaudePermissionMode;
  prompt?: string;
  extraEnv?: Record<string, string>;
}

/**
 * Builds a launch spec for secondary CLI coding agents (`antigravity`, `copilot`, `gemini`, `codex`, or `aider`),
 * wrapping execution with `emberline-hook` lifecycle signals so core tracks `working` -> `done` / `failed`.
 * If a secondary CLI binary is not yet installed in the runner image, gracefully falls back to `claude` with
 * the corresponding model & specialist mode so runs never fail with `command not found`.
 */
export function buildSecondaryCliLaunchSpec(options: SecondaryCliLaunchOptions): LaunchSpec {
  const hook = options.hookCommand ?? 'emberline-hook';
  const autoApprove = options.permissionMode !== 'plan';
  const fallbackModel = resolveClaudeCliModelFlag(options.model) ?? 'sonnet';
  const claudeFallback = `claude --permission-mode auto --model ${fallbackModel} -- "$EMBERLINE_PROMPT"`;

  let cliCmd: string;
  if (options.agent === 'antigravity') {
    const bin = process.env.EMBERLINE_ANTIGRAVITY_COMMAND?.trim() || 'agy';
    const modelFlag = options.model && options.model !== 'auto' ? `--model ${options.model} ` : '--model argon ';
    cliCmd = options.prompt
      ? `if command -v ${bin} >/dev/null 2>&1; then ${bin} ${modelFlag}-p "$EMBERLINE_PROMPT"; elif command -v antigravity >/dev/null 2>&1; then antigravity ${modelFlag}-p "$EMBERLINE_PROMPT"; else ${claudeFallback}; fi`
      : `if command -v ${bin} >/dev/null 2>&1; then ${bin}; else claude --model ${fallbackModel}; fi`;
  } else if (options.agent === 'copilot') {
    const bin = process.env.EMBERLINE_COPILOT_COMMAND?.trim() || 'copilot';
    cliCmd = options.prompt
      ? `if command -v ${bin} >/dev/null 2>&1; then ${bin} -p "$EMBERLINE_PROMPT"; elif command -v gh >/dev/null 2>&1 && gh copilot --version >/dev/null 2>&1; then gh copilot suggest -t shell "$EMBERLINE_PROMPT"; else ${claudeFallback}; fi`
      : `if command -v ${bin} >/dev/null 2>&1; then ${bin}; else claude --model sonnet; fi`;
  } else if (options.agent === 'gemini') {
    const bin = process.env.EMBERLINE_GEMINI_COMMAND?.trim() || 'gemini';
    const geminiModel =
      options.model === 'gemini-pro'
        ? '--model gemini-2.5-pro '
        : options.model === 'gemini-flash'
          ? '--model gemini-2.5-flash '
          : options.model === 'gemini-flash-lite'
            ? '--model gemini-2.5-flash-lite '
            : '';
    const flags = `${autoApprove ? '--yolo ' : ''}${geminiModel}`;
    cliCmd = options.prompt
      ? `${bin} ${flags}-p "$EMBERLINE_PROMPT"`
      : `${bin} ${flags}`.trim();
  } else if (options.agent === 'codex') {
    const bin = process.env.EMBERLINE_CODEX_COMMAND?.trim() || 'codex';
    const codexModel =
      options.model && options.model !== 'auto' ? `--model ${options.model} ` : '';
    const flags = `${autoApprove ? '--full-auto ' : ''}${codexModel}`;
    cliCmd = options.prompt
      ? `${bin} exec ${autoApprove ? '--full-auto --skip-git-repo-check ' : ''}${codexModel}"$EMBERLINE_PROMPT"`
      : `${bin} ${flags}`.trim();
  } else {
    const bin = process.env.EMBERLINE_AIDER_COMMAND?.trim() || 'aider';
    const aiderModel =
      options.model && options.model !== 'auto' ? `--model ${options.model} ` : '';
    const flags = `${autoApprove ? '--yes-always ' : ''}${aiderModel}`;
    cliCmd = options.prompt
      ? `${bin} ${flags}--message "$EMBERLINE_PROMPT"`
      : `${bin} ${flags}`.trim();
  }

  const watcherSnippet = options.prompt
    ? `( LAST_GIT=""; while sleep 2; do CUR_GIT=$(git status --porcelain 2>/dev/null | head -n 5 | tr '\\n' ' ' | sed 's/["\\\\]/ /g'); if [ -n "$CUR_GIT" ] && [ "$CUR_GIT" != "$LAST_GIT" ]; then LAST_GIT="$CUR_GIT"; echo "{\\"tool_name\\":\\"Edit\\",\\"message\\":\\"Worktree updated: $CUR_GIT\\"}" | ${hook} PreToolUse >/dev/null 2>&1 || true; echo "{\\"tool_name\\":\\"Edit\\",\\"message\\":\\"Worktree updated: $CUR_GIT\\"}" | ${hook} PostToolUse >/dev/null 2>&1 || true; fi; done ) & EMBERLINE_WATCH_PID=$!`
    : '';

  const script = [
    `echo '{"session_id":"'${options.agent}-${options.runId.slice(0, 8)}'"}' | ${hook} SessionStart >/dev/null 2>&1 || true`,
    options.prompt
      ? `echo '{"prompt":"started"}' | ${hook} UserPromptSubmit >/dev/null 2>&1 || true`
      : '',
    options.prompt
      ? `echo '{"tool_name":"${options.agent}","message":"Executing ${options.agent} CLI task"}' | ${hook} PreToolUse >/dev/null 2>&1 || true`
      : '',
    watcherSnippet,
    cliCmd,
    `STATUS=$?`,
    options.prompt ? `kill "$EMBERLINE_WATCH_PID" >/dev/null 2>&1 || true` : '',
    `if [ "$STATUS" -eq 0 ]; then echo '{"tool_name":"${options.agent}","message":"Completed ${options.agent} CLI task"}' | ${hook} PostToolUse >/dev/null 2>&1 || true; echo '{}' | ${hook} Stop >/dev/null 2>&1 || true; else echo '{"error":"cli_exit","reason":"${options.agent} exited with non-zero code"}' | ${hook} StopFailure >/dev/null 2>&1 || true; fi`,
    `exit $STATUS`,
  ]
    .filter(Boolean)
    .join('; ');

  return {
    file: 'sh',
    args: ['-c', script],
    env: {
      ...options.extraEnv,
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
