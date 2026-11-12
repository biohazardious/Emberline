/**
 * Claude Code adapter.
 *
 * - ./settings.ts: the `--settings` object wiring every hook to `emberline-hook`, and the MCP servers.
 * - ./launch.ts: the full command line + env for a run.
 * - ./personas.ts: persona prompts and the unattended-run policy.
 * - ./secondary.ts: Antigravity, Copilot and Aider on the generic wrapper, with a Claude fallback.
 * - ./ratelimit.ts: usage-limit detection and reset-time parsing, behind fixture tests.
 *
 * This module turns them into the {@link ProviderAdapter}s core registers.
 */
import {
  type AgentState,
  decorateWithPersona,
  type HookPayloadLike,
  nextStateFromHookWith,
  type ProviderAdapter,
} from '@emberline/adapter-sdk';
import type { HookEventName } from '@emberline/protocol';
import { buildLaunchSpec } from './launch.js';
import {
  isQuotaWaitNotification,
  type LimitContext,
  rateLimitFromHook,
  rateLimitFromScreen,
  transientErrorFromHook,
} from './ratelimit.js';
import { buildSecondaryCliLaunchSpec, headlessModeProblem, type SecondaryAgent } from './secondary.js';

export * from './launch.js';
export * from './personas.js';
export * from './ratelimit.js';
export * from './secondary.js';
export * from './settings.js';
export { isAutonomousPermissionMode, stateAfterExit } from '@emberline/adapter-sdk';

/** How Claude Code's (and its fallbacks') wording drives the shared hook state machine. */
function claudeStateRules(ctx: LimitContext | undefined) {
  return {
    isRateLimit: (event: string, payload: HookPayloadLike) =>
      rateLimitFromHook(event, payload, new Date(), 'UTC', ctx) !== undefined,
    isQuotaWait: isQuotaWaitNotification,
  };
}

/**
 * Derives the next agent state from a hook (see the SDK's `nextStateFromHookWith`). `StopFailure`
 * with a usage limit -> `rate_limited` (the scheduler resumes it); any other error needs the user.
 */
export function nextStateFromHook(
  current: AgentState,
  event: HookEventName,
  payload: HookPayloadLike = {},
  ctx?: LimitContext,
): AgentState | undefined {
  return nextStateFromHookWith(claudeStateRules(ctx), current, event, payload);
}

/** Prompt typed into a session to pick up after a limit reset. */
export const CONTINUE_PROMPT = 'Continue where you left off.';

export const CLAUDE_ADAPTER_ID = 'claude';

/** Claude Code: native hooks through `--settings`, the `emberline` MCP server, skill prompts. */
export const claudeAdapter: ProviderAdapter = {
  id: CLAUDE_ADAPTER_ID,
  displayName: 'Claude',
  hooks: 'native',
  completionSignal: 'tool',
  launch: (ctx) =>
    buildLaunchSpec({
      runId: ctx.runId,
      hookToken: ctx.hookToken,
      coreUrl: ctx.coreUrl,
      claudeCommand: ctx.claude.command,
      hookCommand: ctx.hookCommand,
      permissionMode: ctx.permissionMode,
      model: ctx.model,
      prompt: ctx.prompt,
      resumeSessionId: ctx.resumeSessionId,
      playwrightMcp: ctx.claude.playwrightMcp,
      ticketRun: ctx.claude.ticketRun,
      customMcpServers: ctx.claude.customMcpServers,
      extraSystemPrompt: ctx.claude.extraSystemPrompt,
    }),
  decoratePrompt: decorateWithPersona,
  headlessProblem: () => null,
  nextState: (current, event, payload, options) =>
    nextStateFromHookWith(
      claudeStateRules({ agent: CLAUDE_ADAPTER_ID, model: options?.model }),
      current,
      event,
      payload,
    ),
  rateLimitFromHook: (event, payload, options) =>
    rateLimitFromHook(event, payload, options?.now, options?.timeZone, {
      agent: CLAUDE_ADAPTER_ID,
      model: options?.model,
    }),
  rateLimitFromScreen: (ansi, options) =>
    rateLimitFromScreen(ansi, options?.now, options?.timeZone, {
      agent: CLAUDE_ADAPTER_ID,
      model: options?.model,
    }),
  transientErrorFromHook: (event, payload, options) =>
    transientErrorFromHook(event, payload, { agent: CLAUDE_ADAPTER_ID, model: options?.model }),
};

/** A wrapped CLI with a Claude fallback (Antigravity, Copilot, Aider). */
export function secondaryCliAdapter(agent: SecondaryAgent, displayName: string): ProviderAdapter {
  const ctx = (model?: string | null): LimitContext => ({ agent, model });
  return {
    id: agent,
    displayName,
    hooks: 'wrapper',
    completionSignal: 'exit',
    launch: (launch) =>
      buildSecondaryCliLaunchSpec({
        agent,
        model: launch.model,
        runId: launch.runId,
        hookToken: launch.hookToken,
        coreUrl: launch.coreUrl,
        hookCommand: launch.hookCommand,
        permissionMode: launch.permissionMode,
        prompt: launch.prompt,
        resumeSessionId: launch.resumeSessionId,
        extraEnv: launch.extraEnv,
      }),
    decoratePrompt: decorateWithPersona,
    headlessProblem: (mode, hasPrompt) => headlessModeProblem(agent, mode, hasPrompt),
    nextState: (current, event, payload, options) =>
      nextStateFromHookWith(claudeStateRules(ctx(options?.model)), current, event, payload),
    rateLimitFromHook: (event, payload, options) =>
      rateLimitFromHook(event, payload, options?.now, options?.timeZone, ctx(options?.model)),
    rateLimitFromScreen: (ansi, options) =>
      rateLimitFromScreen(ansi, options?.now, options?.timeZone, ctx(options?.model)),
    transientErrorFromHook: (event, payload, options) =>
      transientErrorFromHook(event, payload, ctx(options?.model)),
  };
}
