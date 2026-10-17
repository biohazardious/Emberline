import {
  buildLaunchSpec,
  buildSecondaryCliLaunchSpec,
  type ClaudeMcpServerSpec,
  type ClaudeModelTier,
  type ClaudePermissionMode,
} from '@emberline/adapter-claude';
import type { LaunchSpec } from '@emberline/adapter-sdk';

/** Everything a provider needs to build the command line for one agent session. */
export interface ProviderLaunchContext {
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  permissionMode: ClaudePermissionMode;
  model: ClaudeModelTier;
  prompt?: string;
  resumeSessionId?: string;
  extraEnv: Record<string, string>;
  /** Claude-native extras; providers without `claudeNative` ignore them. */
  claude: {
    command?: string;
    playwrightMcp: boolean;
    /** The run works on a ticket (its prompt carries the completion instruction). */
    ticketRun?: boolean;
    customMcpServers?: Record<string, ClaudeMcpServerSpec>;
    extraSystemPrompt?: string;
  };
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /**
   * Claude Code itself: full hook-based state tracking, MCP servers (Playwright, registry) and
   * skill/rule system-prompt plugins. Other CLIs run through a generic wrapper.
   */
  readonly claudeNative: boolean;
  launch(ctx: ProviderLaunchContext): LaunchSpec;
}

const claude: ProviderAdapter = {
  id: 'claude',
  displayName: 'Claude',
  claudeNative: true,
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
};

type SecondaryAgent = Parameters<typeof buildSecondaryCliLaunchSpec>[0]['agent'];

const secondary = (id: SecondaryAgent, displayName: string): ProviderAdapter => ({
  id,
  displayName,
  claudeNative: false,
  launch: (ctx) =>
    buildSecondaryCliLaunchSpec({
      agent: id,
      model: ctx.model,
      runId: ctx.runId,
      hookToken: ctx.hookToken,
      coreUrl: ctx.coreUrl,
      hookCommand: ctx.hookCommand,
      permissionMode: ctx.permissionMode,
      prompt: ctx.prompt,
      resumeSessionId: ctx.resumeSessionId,
      extraEnv: ctx.extraEnv,
    }),
});

const PROVIDERS: ReadonlyMap<string, ProviderAdapter> = new Map(
  [
    claude,
    secondary('antigravity', 'Antigravity'),
    secondary('copilot', 'Copilot'),
    secondary('gemini', 'Gemini'),
    secondary('codex', 'Codex'),
    secondary('aider', 'Aider'),
  ].map((adapter) => [adapter.id, adapter]),
);

/** The adapter for a run's `agent`; unknown ids (e.g. a stale prompt route tag) run Claude. */
export function providerAdapter(agent: string): ProviderAdapter {
  return PROVIDERS.get(agent) ?? claude;
}

export function providerIds(): string[] {
  return [...PROVIDERS.keys()];
}
