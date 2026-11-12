/**
 * The wrapped CLIs that fall back to Claude Code when their binary is missing: Antigravity,
 * Copilot and Aider, on the SDK's generic wrapper.
 */
import {
  buildWrappedCliLaunchSpec,
  headlessAskProblem,
  isAutonomousPermissionMode,
  type LaunchSpec,
} from '@emberline/adapter-sdk';
import { resolveClaudeCliModelFlag } from './launch.js';
import {
  buildHookSettings,
  CLAUDE_DIALOG_ENV,
  type ClaudeHookSettings,
  type ClaudePermissionMode,
  EMBERLINE_TOOLS,
} from './settings.js';

/** Wrapped CLIs that run a prompt with `-p`: nobody can answer their approval questions. Names as the web shows them. */
const HEADLESS_AGENT_NAMES: ReadonlyMap<string, string> = new Map([
  ['antigravity', 'Antigravity'],
  ['copilot', 'Copilot'],
]);

/**
 * Why `agent` (one of the CLIs this package launches) cannot run a prompt in `mode`, or null.
 * Only `auto` and `bypassPermissions` run unattended; Claude Code itself asks in its own terminal.
 */
export function headlessModeProblem(
  agent: string,
  mode: ClaudePermissionMode | undefined,
  hasPrompt: boolean,
): string | null {
  const name = HEADLESS_AGENT_NAMES.get(agent);
  return name ? headlessAskProblem(name, mode, hasPrompt) : null;
}

export type SecondaryAgent = 'antigravity' | 'copilot' | 'aider';

export interface SecondaryCliLaunchOptions {
  agent: SecondaryAgent;
  model?: string;
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  permissionMode?: ClaudePermissionMode;
  prompt?: string;
  resumeSessionId?: string;
  extraEnv?: Record<string, string>;
}

/** Run settings for the Claude fallback of a secondary CLI: every pre-answered dialog, no hooks. */
function claudeFallbackSettings(autonomous: boolean): Omit<ClaudeHookSettings, 'hooks'> {
  const { hooks: _hooks, ...dialogs } = buildHookSettings('emberline-hook', 5, autonomous);
  // Secondary CLIs have no `emberline` MCP server and signal completion by their exit code.
  const { allow, ...permissions } = dialogs.permissions ?? {};
  const kept = (allow ?? []).filter((rule) => !EMBERLINE_TOOLS.includes(rule));
  return { ...dialogs, permissions: { ...permissions, ...(kept.length > 0 ? { allow: kept } : {}) } };
}

/**
 * Builds a launch spec for the wrapped CLIs that fall back to Claude (`antigravity`, `copilot`,
 * `aider`) on the SDK's generic wrapper, which reports `working` -> `done` / `failed` through
 * `emberline-hook`. If the CLI binary is not installed in the runner image, Antigravity and Copilot
 * fall back to `claude` with the corresponding model so runs never fail with `command not found`.
 * Codex and Gemini CLI have their own adapter packages.
 */
export function buildSecondaryCliLaunchSpec(options: SecondaryCliLaunchOptions): LaunchSpec {
  const autoApprove = isAutonomousPermissionMode(options.permissionMode);
  const fallbackModel = resolveClaudeCliModelFlag(options.model) ?? 'sonnet';
  // The Claude fallback gets the same pre-answered dialogs as a Claude run (its state comes from this
  // script's hooks, so not Claude's own).
  const claudeFallback = `claude --settings "$EMBERLINE_CLAUDE_SETTINGS" --no-chrome --permission-mode ${autoApprove ? 'auto' : 'default'} --model ${fallbackModel} -- "$EMBERLINE_PROMPT"`;
  const extraEnv: Record<string, string> = {};

  // Every CLI below has first-run questions (folder trust, update offers, onboarding) that would wait
  // in the PTY for an answer nobody gives; each one is pre-answered with a flag, an env var, or a
  // config entry that `emberline-cli-seed` merges into the runner's home before the CLI starts.
  let cliCmd: string;
  if (options.agent === 'antigravity') {
    const bin = process.env.EMBERLINE_ANTIGRAVITY_COMMAND?.trim() || 'agy';
    const modelFlag =
      options.model && options.model !== 'auto' ? `--model ${options.model} ` : '--model argon ';
    const continueFlag = options.resumeSessionId ? '-c ' : '';
    // The agy wrapper may fall back to Gemini CLI, which refuses untrusted folders.
    extraEnv.GEMINI_CLI_TRUST_WORKSPACE = 'true';
    cliCmd = options.prompt
      ? `if command -v ${bin} >/dev/null 2>&1; then ${bin} ${continueFlag}${modelFlag}-p "$EMBERLINE_PROMPT"; elif command -v antigravity >/dev/null 2>&1; then antigravity ${continueFlag}${modelFlag}-p "$EMBERLINE_PROMPT"; else ${claudeFallback}; fi`
      : `if command -v ${bin} >/dev/null 2>&1; then ${bin} ${continueFlag}; else claude --model ${fallbackModel}; fi`;
  } else if (options.agent === 'copilot') {
    const bin = process.env.EMBERLINE_COPILOT_COMMAND?.trim() || 'copilot';
    // Unattended runs may use every tool and never ask; otherwise -p denies what needs approval.
    const flags = autoApprove ? '--allow-all --no-ask-user ' : '';
    extraEnv.COPILOT_AUTO_UPDATE = 'false';
    cliCmd = options.prompt
      ? `if command -v ${bin} >/dev/null 2>&1; then ${bin} ${flags}-p "$EMBERLINE_PROMPT"; elif command -v gh >/dev/null 2>&1 && gh copilot --version >/dev/null 2>&1; then gh copilot suggest -t shell "$EMBERLINE_PROMPT"; else ${claudeFallback}; fi`
      : `if command -v ${bin} >/dev/null 2>&1; then ${`${bin} ${flags}`.trim()}; else claude --model sonnet; fi`;
  } else {
    const bin = process.env.EMBERLINE_AIDER_COMMAND?.trim() || 'aider';
    const aiderModel = options.model && options.model !== 'auto' ? `--model ${options.model} ` : '';
    // First-run questions (gitignore, release notes, analytics, model warnings, URLs, updates) would
    // wait on the PTY; --no-gitignore also keeps aider from editing the project's .gitignore.
    const quiet =
      '--no-gitignore --no-show-release-notes --no-show-model-warnings --no-check-update --analytics-disable --no-detect-urls ';
    const flags = `${autoApprove ? '--yes-always ' : ''}${quiet}${aiderModel}`;
    cliCmd = options.prompt ? `${bin} ${flags}--message "$EMBERLINE_PROMPT"` : `${bin} ${flags}`.trim();
  }

  return buildWrappedCliLaunchSpec({
    agent: options.agent,
    runId: options.runId,
    hookToken: options.hookToken,
    coreUrl: options.coreUrl,
    hookCommand: options.hookCommand,
    prompt: options.prompt,
    command: cliCmd,
    autoApprove,
    // Aider reports a failed login and still exits 0.
    statusCheck:
      options.agent === 'aider'
        ? (log) =>
            `if [ "$STATUS" -eq 0 ] && grep -qi "not able to authenticate" "${log}" 2>/dev/null; then STATUS=1; fi`
        : undefined,
    extraEnv: options.extraEnv,
    env: {
      EMBERLINE_CLAUDE_SETTINGS: JSON.stringify(claudeFallbackSettings(autoApprove)),
      ...CLAUDE_DIALOG_ENV,
      ...extraEnv,
    },
  });
}
