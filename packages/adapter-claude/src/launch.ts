/** The command line and environment of a Claude Code session. */
import { isAutonomousPermissionMode, type LaunchSpec } from '@emberline/adapter-sdk';
import { AUTONOMOUS_EXECUTION_POLICY, RUNNER_ENVIRONMENT } from './personas.js';
import {
  buildEmberlineMcpConfig,
  buildHookSettings,
  buildPlaywrightMcpConfig,
  CLAUDE_DIALOG_ENV,
  type ClaudeMcpServerSpec,
  type ClaudePermissionMode,
  COMPLETION_INSTRUCTION,
} from './settings.js';

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
  model?: string;
  /** Initial prompt; empty starts an idle interactive session. */
  prompt?: string;
  /** Claude session id to continue (`--resume`). */
  resumeSessionId?: string;
  /** When true, passes `--mcp-config` wiring headless `@playwright/mcp`. */
  playwrightMcp?: boolean;
  /** Optional persona-scoped MCP servers from the Factory MCP Registry. */
  customMcpServers?: Record<string, ClaudeMcpServerSpec>;
  /** The run works on a ticket: its prompt gets the `ticket_complete` instruction. */
  ticketRun?: boolean;
  /** Optional active Skill / Rule Plugin instructions to append to the system prompt. */
  extraSystemPrompt?: string;
}

/** Claude Code's `--model` for an Emberline model id (another provider's id maps to its Claude tier). */
export function resolveClaudeCliModelFlag(model?: string): string | undefined {
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

/**
 * In `auto`/`bypassPermissions` the session starts unattended with pre-authorized Bash/Edit/Write
 * permissions and the autonomous non-interactive system prompt.
 */
export function buildLaunchSpec(options: ClaudeLaunchOptions): LaunchSpec {
  const isAutonomous = isAutonomousPermissionMode(options.permissionMode);
  const settings = buildHookSettings(
    options.hookCommand ?? 'emberline-hook',
    5,
    isAutonomous,
    options.permissionMode ?? 'default',
  );
  const customServerKeys = options.customMcpServers ? Object.keys(options.customMcpServers) : [];
  if (isAutonomous && settings.permissions?.allow && customServerKeys.length > 0) {
    const allowSet = new Set(settings.permissions.allow);
    for (const srvId of customServerKeys) {
      allowSet.add(`mcp__${srvId}__*`);
    }
    settings.permissions.allow = Array.from(allowSet);
  }
  // Claude in Chrome would offer to drive the user's own browser (its extension is found through the
  // account) in a dialog nobody answers; runs use the runner's headless Chromium instead.
  const args = ['--settings', JSON.stringify(settings), '--no-chrome'];
  // `emberline` is added last so a registry server can never shadow it.
  const mergedServers: Record<string, ClaudeMcpServerSpec> = {
    ...(options.playwrightMcp ? buildPlaywrightMcpConfig().mcpServers : {}),
    ...options.customMcpServers,
    ...buildEmberlineMcpConfig().mcpServers,
  };
  args.push('--mcp-config', JSON.stringify({ mcpServers: mergedServers }));
  const cliModel = resolveClaudeCliModelFlag(options.model);
  if (cliModel) {
    args.push('--model', cliModel);
  }
  if (isAutonomous) {
    const cliMode = options.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'auto';
    args.push('--permission-mode', cliMode);
    let extraPolicy =
      options.model === 'fable'
        ? `${AUTONOMOUS_EXECUTION_POLICY}\n[FABLE DEEP-ANALYSIS MODE: Perform deep architectural synthesis, edge-case analysis, and root-cause verification before writing code.]`
        : AUTONOMOUS_EXECUTION_POLICY;
    extraPolicy = `${extraPolicy}\n\n${RUNNER_ENVIRONMENT}`;
    if (options.extraSystemPrompt?.trim()) {
      extraPolicy = `${extraPolicy}\n\n${options.extraSystemPrompt.trim()}`;
    }
    args.push('--append-system-prompt', extraPolicy);
  } else {
    if (options.permissionMode && options.permissionMode !== 'default') {
      args.push('--permission-mode', options.permissionMode);
    }
    const extra = options.extraSystemPrompt?.trim();
    args.push('--append-system-prompt', extra ? `${RUNNER_ENVIRONMENT}\n\n${extra}` : RUNNER_ENVIRONMENT);
  }
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  // `--` ends option parsing so a prompt starting with "-" is never read as a flag.
  if (options.prompt) {
    args.push('--', options.ticketRun ? `${options.prompt}\n\n${COMPLETION_INSTRUCTION}` : options.prompt);
  }
  return {
    file: options.claudeCommand ?? 'claude',
    args,
    env: {
      EMBERLINE_RUN_ID: options.runId,
      EMBERLINE_HOOK_TOKEN: options.hookToken,
      EMBERLINE_CORE_URL: options.coreUrl,
      DISABLE_AUTOUPDATER: '1',
      // Each run gets a fresh git worktree, and Claude Code (2.1.300+) only inherits folder trust up to
      // the git root, so every run would stop at the "trust this folder?" dialog. The runner container
      // is the sandbox boundary; this tells Claude Code so.
      CLAUDE_CODE_SANDBOXED: '1',
      ...CLAUDE_DIALOG_ENV,
    },
  };
}
