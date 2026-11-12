/**
 * Gemini CLI adapter (docs/DESIGN.md §3.3): `gemini -p` under the SDK's generic wrapper, the
 * worktree trusted through the environment, completion by exit code, and usage-limit detection from
 * the failure hook and the screen (./ratelimit.ts).
 */
import {
  type AgentPermissionMode,
  buildWrappedCliLaunchSpec,
  decorateWithPersona,
  headlessAskProblem,
  isAutonomousPermissionMode,
  type LaunchSpec,
  nextStateFromHookWith,
  type ProviderAdapter,
} from '@emberline/adapter-sdk';
import {
  rateLimitFromGeminiHook,
  rateLimitFromGeminiScreen,
  transientErrorFromGeminiHook,
} from './ratelimit.js';

export * from './ratelimit.js';

export const GEMINI_ADAPTER_ID = 'gemini';
const DISPLAY_NAME = 'Gemini';

export interface GeminiLaunchOptions {
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  permissionMode?: AgentPermissionMode;
  /** Emberline model id (`gemini-pro`, `gemini-flash`, `gemini-flash-lite`); others keep the CLI's default. */
  model?: string;
  prompt?: string;
  extraEnv?: Record<string, string>;
  /** The `gemini` executable; defaults to `$EMBERLINE_GEMINI_COMMAND` or `gemini`. */
  command?: string;
}

/** Emberline model ids -> Gemini CLI's `--model`. */
const GEMINI_MODELS: ReadonlyMap<string, string> = new Map([
  ['gemini-pro', 'gemini-2.5-pro'],
  ['gemini-flash', 'gemini-2.5-flash'],
  ['gemini-flash-lite', 'gemini-2.5-flash-lite'],
]);

export function buildGeminiLaunchSpec(options: GeminiLaunchOptions): LaunchSpec {
  const bin = options.command ?? (process.env.EMBERLINE_GEMINI_COMMAND?.trim() || 'gemini');
  const autoApprove = isAutonomousPermissionMode(options.permissionMode);
  const cliModel = options.model ? GEMINI_MODELS.get(options.model) : undefined;
  // In -p mode, tools that need approval are denied rather than asked.
  const approval = autoApprove
    ? '--yolo '
    : options.permissionMode === 'acceptEdits'
      ? '--approval-mode auto_edit '
      : '';
  const flags = `${approval}${cliModel ? `--model ${cliModel} ` : ''}`;
  return buildWrappedCliLaunchSpec({
    agent: GEMINI_ADAPTER_ID,
    runId: options.runId,
    hookToken: options.hookToken,
    coreUrl: options.coreUrl,
    hookCommand: options.hookCommand,
    prompt: options.prompt,
    command: options.prompt ? `${bin} ${flags}-p "$EMBERLINE_PROMPT"` : `${bin} ${flags}`.trim(),
    autoApprove,
    extraEnv: options.extraEnv,
    // Gemini CLI refuses (exit 55) or downgrades --yolo in folders it does not trust; every run is a
    // fresh worktree.
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
  });
}

export const geminiAdapter: ProviderAdapter = {
  id: GEMINI_ADAPTER_ID,
  displayName: DISPLAY_NAME,
  hooks: 'wrapper',
  completionSignal: 'exit',
  launch: (ctx) =>
    buildGeminiLaunchSpec({
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
  headlessProblem: (mode, hasPrompt) => headlessAskProblem(DISPLAY_NAME, mode, hasPrompt),
  nextState: (current, event, payload, options) =>
    nextStateFromHookWith(
      { isRateLimit: (e, p) => rateLimitFromGeminiHook(e, p, options) !== undefined },
      current,
      event,
      payload,
    ),
  rateLimitFromHook: rateLimitFromGeminiHook,
  rateLimitFromScreen: rateLimitFromGeminiScreen,
  transientErrorFromHook: transientErrorFromGeminiHook,
};
