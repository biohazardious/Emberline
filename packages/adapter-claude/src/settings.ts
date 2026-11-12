/**
 * What Emberline installs into a Claude Code session: the `--settings` object (every hook wired to
 * `emberline-hook`, every dialog pre-answered) and the `--mcp-config` servers.
 */
import type { AgentPermissionMode, McpServerSpec } from '@emberline/adapter-sdk';
import type { HookEventName } from '@emberline/protocol';

export type ClaudePermissionMode = AgentPermissionMode;

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

/** The tool through which a Claude run tells Emberline its ticket is finished (served by `emberline-mcp`). */
export const COMPLETION_TOOL = 'mcp__emberline__ticket_complete';

/** The tool with which a Claude run starts its own preview and gets the URL to open (served by `emberline-mcp`). */
export const PREVIEW_TOOL = 'mcp__emberline__preview';

/** The `emberline` server's tools (the Claude fallback of a secondary CLI has neither). */
export const EMBERLINE_TOOLS = [COMPLETION_TOOL, PREVIEW_TOOL];

/** Appended to the prompt of a run that works on a ticket. */
export const COMPLETION_INSTRUCTION =
  'When this ticket is finished and its work is saved in the worktree, call the `ticket_complete` tool with a short summary and a handoff note for whoever builds on it. If it cannot be finished, call it with `blockers` listing why. Do not call it while you are waiting for an answer to a question.';

/** Hooks Emberline listens to for state detection (docs/DESIGN.md §3.3). */
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
  /** Renderer; any value also stops Claude Code from offering the fullscreen one mid-turn. */
  tui: 'default';
  spinnerTipsEnabled: false;
  /** The bypass-mode warning defaults to "No, exit"; nobody is there to answer it. */
  skipDangerousModePermissionPrompt: true;
  /** A fresh worktree is never "trusted", so a repo's .mcp.json would be asked about on every run. */
  enableAllProjectMcpServers: true;
  /** When a safeguard flags a message, switch models instead of asking which to prefer. */
  switchModelsOnFlag: true;
  skillOverrides: { 'auto-mode-setup': 'off' };
  modelProposedGoals: 'disabled';
  /**
   * The CLI pipes its status (with subscription `rate_limits`) to this runner script, which keeps the
   * latest limits for Emberline's usage view; Emberline never reads or sends the login token itself.
   */
  statusLine: { type: 'command'; command: string; padding: 0 };
  /** Auto-continue a question the agent asks despite running unattended. */
  askUserQuestionTimeout?: string;
  permissions: {
    /** Always set: otherwise Claude Code offers to make auto mode the default, mid-session. */
    defaultMode: ClaudePermissionMode;
    allow?: string[];
  };
}

/** Tool events require a matcher; an empty string matches every tool. */
const MATCHER_EVENTS = new Set<HookEventName>(['PreToolUse', 'PostToolUse']);

/**
 * Builds the settings object passed to `claude --settings <json>` for a run.
 * Every watched hook invokes `<hookCommand> <EventName>`; the run id travels via env.
 * When `autonomous` is enabled, pre-allows Bash/Edit/Write tools and sets `defaultMode: 'auto'`.
 *
 * Settings passed this way override the user's own (~/.claude/settings.json). They also answer, in
 * advance, every dialog Claude Code would otherwise open in the terminal and wait on: Emberline reads
 * the agent's screen and hooks, but nobody sits at the keyboard of an unattended run.
 */
export function buildHookSettings(
  hookCommand: string,
  timeoutSeconds = 5,
  autonomous = false,
  permissionMode: ClaudePermissionMode = 'default',
): ClaudeHookSettings {
  const hooks: ClaudeHookSettings['hooks'] = {};
  for (const event of WATCHED_HOOKS) {
    const group: HookMatcherGroup = {
      hooks: [{ type: 'command', command: `${hookCommand} ${event}`, timeout: timeoutSeconds }],
    };
    if (MATCHER_EVENTS.has(event)) group.matcher = '';
    hooks[event] = [group];
  }
  const base = {
    hooks,
    // Classic renderer: Emberline reads the agent's screen (limit banners, Fleet thumbnails), and any
    // value here also suppresses the "Try the new fullscreen renderer?" dialog mid-turn.
    tui: 'default',
    spinnerTipsEnabled: false,
    skipDangerousModePermissionPrompt: true,
    enableAllProjectMcpServers: true,
    switchModelsOnFlag: true,
    skillOverrides: { 'auto-mode-setup': 'off' },
    modelProposedGoals: 'disabled',
    statusLine: { type: 'command', command: 'claude-statusline.mjs', padding: 0 },
  } as const;
  if (autonomous) {
    return {
      ...base,
      askUserQuestionTimeout: '60s',
      permissions: {
        defaultMode: 'auto',
        allow: [...AUTONOMOUS_ALLOWED_TOOLS, ...EMBERLINE_TOOLS],
      },
    };
  }
  // The completion tool is allowed in every mode: signalling "done" must never wait for an approval.
  // `preview` is not: it runs the worktree's dev script or `docker compose up --build`, files the
  // agent can edit, so it asks like Bash does here (it is pre-allowed with Bash in the autonomous modes).
  return { ...base, permissions: { defaultMode: permissionMode, allow: [COMPLETION_TOOL] } };
}

export type ClaudeMcpServerSpec = McpServerSpec;

export interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpServerSpec>;
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

/**
 * The `emberline` stdio server (`emberline-mcp`, serving `ticket_complete` and `preview`). The run's
 * identity reaches it through `${VAR}` expansion of the CLI process env, so the hook token never
 * appears on a command line.
 */
export function buildEmberlineMcpConfig(): ClaudeMcpConfig {
  return {
    mcpServers: {
      emberline: {
        type: 'stdio',
        command: 'emberline-mcp',
        env: {
          EMBERLINE_RUN_ID: '${EMBERLINE_RUN_ID}',
          EMBERLINE_HOOK_TOKEN: '${EMBERLINE_HOOK_TOKEN}',
          EMBERLINE_CORE_URL: '${EMBERLINE_CORE_URL}',
        },
      },
    },
  };
}

/** Env that keeps Claude Code's surveys and cost acknowledgements out of a run's terminal. */
export const CLAUDE_DIALOG_ENV = {
  // The session-feedback survey takes keystrokes; a prompt typed into the PTY must not answer it.
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  // The cost-threshold acknowledgement (API billing) would wait for a keypress after a turn.
  DISABLE_COST_WARNINGS: '1',
} as const;
