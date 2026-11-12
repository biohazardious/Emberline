/**
 * Codex CLI adapter (docs/DESIGN.md §3.3): `codex exec` under the SDK's generic wrapper, first-run
 * questions pre-answered by flags and `emberline-cli-seed`, completion by exit code, and usage-limit
 * detection from the failure hook, the session rollout and the screen (./ratelimit.ts).
 */
import {
  type AgentPermissionMode,
  buildWrappedCliLaunchSpec,
  decorateWithPersona,
  isAutonomousPermissionMode,
  type LaunchSpec,
  nextStateFromHookWith,
  type ProviderAdapter,
} from '@emberline/adapter-sdk';
import {
  rateLimitFromCodexHook,
  rateLimitFromCodexScreen,
  transientErrorFromCodexHook,
} from './ratelimit.js';

export * from './ratelimit.js';

export const CODEX_ADAPTER_ID = 'codex';

export interface CodexLaunchOptions {
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  permissionMode?: AgentPermissionMode;
  /** Emberline model id; anything but `auto` is passed to `--model` as is. */
  model?: string;
  prompt?: string;
  extraEnv?: Record<string, string>;
  /** The `codex` executable; defaults to `$EMBERLINE_CODEX_COMMAND` or `codex`. */
  command?: string;
}

/**
 * The latest `rate_limits` record of this run's own session rollout: one written since the run
 * started (`$RUN_STARTED`, see the SDK wrapper) whose `session_meta` names the run's directory.
 * Another run's rollout may belong to another credential, and an old one states limits that have
 * long reset, so neither is read; when no rollout qualifies the probe prints nothing.
 */
export const CODEX_TRANSCRIPT_PROBE = [
  `find "\${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name 'rollout-*.jsonl' -newer "$RUN_STARTED" -exec ls -tr {} + 2>/dev/null`,
  `while IFS= read -r f; do head -n 1 "$f" | grep -qF -e "\\"cwd\\":\\"$PWD\\"" -e "\\"cwd\\":\\"$(pwd -P)\\"" && grep -h '"rate_limits"' "$f"; done`,
].join(' | ');

export function buildCodexLaunchSpec(options: CodexLaunchOptions): LaunchSpec {
  const bin = options.command ?? (process.env.EMBERLINE_CODEX_COMMAND?.trim() || 'codex');
  const autoApprove = isAutonomousPermissionMode(options.permissionMode);
  const codexModel = options.model && options.model !== 'auto' ? `--model ${options.model} ` : '';
  // Codex's own sandbox (bubblewrap) cannot run inside the runner container, which is the sandbox.
  // `--full-auto` no longer exists; unattended means no approvals and no inner sandbox.
  const access = autoApprove ? '--dangerously-bypass-approvals-and-sandbox ' : '-s danger-full-access ';
  const noUpdate = '-c check_for_update_on_startup=false ';
  // `codex exec` reads CODEX_API_KEY, not OPENAI_API_KEY.
  const apiKey =
    'if [ -n "${OPENAI_API_KEY:-}" ] && [ -z "${CODEX_API_KEY:-}" ]; then export CODEX_API_KEY="$OPENAI_API_KEY"; fi; ';
  // The interactive UI asks to trust the repository root (where the worktree's .git lives).
  const trust =
    '-c "projects.\\"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || pwd)")\\".trust_level=\\"trusted\\"" ';
  const command = options.prompt
    ? `${apiKey}${bin} exec ${noUpdate}${access}--skip-git-repo-check ${codexModel}"$EMBERLINE_PROMPT"`
    : `${apiKey}${bin} ${noUpdate}${trust}${autoApprove ? '--dangerously-bypass-approvals-and-sandbox ' : ''}${codexModel}`.trim();
  return buildWrappedCliLaunchSpec({
    agent: CODEX_ADAPTER_ID,
    runId: options.runId,
    hookToken: options.hookToken,
    coreUrl: options.coreUrl,
    hookCommand: options.hookCommand,
    prompt: options.prompt,
    command,
    autoApprove,
    transcriptProbe: CODEX_TRANSCRIPT_PROBE,
    extraEnv: options.extraEnv,
  });
}

export const codexAdapter: ProviderAdapter = {
  id: CODEX_ADAPTER_ID,
  displayName: 'Codex',
  hooks: 'wrapper',
  completionSignal: 'exit',
  launch: (ctx) =>
    buildCodexLaunchSpec({
      runId: ctx.runId,
      hookToken: ctx.hookToken,
      coreUrl: ctx.coreUrl,
      hookCommand: ctx.hookCommand,
      permissionMode: ctx.permissionMode,
      model: ctx.model,
      prompt: ctx.prompt,
      extraEnv: ctx.extraEnv,
    }),
  decoratePrompt: decorateWithPersona,
  // `codex exec` never stops to ask: its approval policy is `never` without a terminal.
  headlessProblem: () => null,
  nextState: (current, event, payload, options) =>
    nextStateFromHookWith(
      { isRateLimit: (e, p) => rateLimitFromCodexHook(e, p, options) !== undefined },
      current,
      event,
      payload,
    ),
  rateLimitFromHook: rateLimitFromCodexHook,
  rateLimitFromScreen: rateLimitFromCodexScreen,
  transientErrorFromHook: transientErrorFromCodexHook,
};
