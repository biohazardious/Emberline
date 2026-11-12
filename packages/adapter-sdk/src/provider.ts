/**
 * The provider contract core dispatches every run through (docs/DESIGN.md §3.3). One implementation
 * per agent CLI, registered in core by agent id; core itself never reads a CLI's wording.
 *
 * Signal precedence, per CLI: hooks first, then the session transcript, the screen last.
 */
import type { AgentState, LaunchSpec } from './index.js';
import type { HookPayloadLike, LimitOptions, RateLimitInfo, TransientErrorInfo } from './limits.js';

export type AgentPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';

/** One MCP server entry as `--mcp-config` (or a CLI's own config) takes it. */
export interface McpServerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: 'stdio' | 'sse' | 'http';
}

/** Everything a provider needs to build the command line for one agent session. */
export interface ProviderLaunchContext {
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  permissionMode: AgentPermissionMode;
  /** Emberline model id (`auto`, `opus`, `gemini-pro`, `o3`, ...); each adapter maps it to its CLI's flag. */
  model: string;
  prompt?: string;
  resumeSessionId?: string;
  /** Provider credentials and settings for this run (API keys scoped to this agent). */
  extraEnv: Record<string, string>;
  /** Claude-native extras; adapters whose `hooks` are `wrapper` ignore them. */
  claude: {
    command?: string;
    playwrightMcp: boolean;
    /** The run works on a ticket (its prompt carries the completion instruction). */
    ticketRun?: boolean;
    customMcpServers?: Record<string, McpServerSpec>;
    extraSystemPrompt?: string;
  };
}

/** A persona's instructions, resolved by core from its catalog. */
export interface PersonaBrief {
  roleTitle: string;
  systemPrompt: string;
  /** Quality rules appended after the persona's prompt; empty for none. */
  rules: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /**
   * How the CLI reports its state: through its own hooks wired by a settings file (`native`, Claude
   * Code: full state tracking, MCP servers, skill prompts), or through Emberline's wrapper script
   * that runs one turn and reports start, edits, completion and failure (`wrapper`). A wrapped CLI
   * exits once its turn is done, so text typed into it afterwards is lost.
   */
  readonly hooks: 'native' | 'wrapper';
  /** How a ticket run says it is finished: the `ticket_complete` MCP tool, or the CLI's exit code. */
  readonly completionSignal: 'tool' | 'exit';
  /** Command line and environment for ptyd, including the CLI's hook and settings installation. */
  launch(ctx: ProviderLaunchContext): LaunchSpec;
  /** Folds a persona's instructions into the first prompt the CLI receives. */
  decoratePrompt(prompt: string, persona: PersonaBrief | undefined): string;
  /** Why the CLI cannot run a prompt in `mode` (it would deny every approval silently), or null. */
  headlessProblem(mode: AgentPermissionMode | undefined, hasPrompt: boolean): string | null;
  /** The next state after a hook, or undefined when it is unchanged. */
  nextState(
    current: AgentState,
    event: string,
    payload: HookPayloadLike,
    options?: LimitOptions,
  ): AgentState | undefined;
  /**
   * A usage limit reported by a hook (with whatever transcript excerpt the hook carries), or undefined.
   * `nextState` returns `rate_limited` exactly when this finds one.
   */
  rateLimitFromHook(
    event: string,
    payload: HookPayloadLike,
    options?: LimitOptions,
  ): RateLimitInfo | undefined;
  /** The last usage-limit banner on a terminal snapshot (serialized ANSI), or undefined. */
  rateLimitFromScreen(ansi: string, options?: LimitOptions): RateLimitInfo | undefined;
  /** A turn that died on a temporary provider or network error worth retrying, or undefined. */
  transientErrorFromHook(
    event: string,
    payload: HookPayloadLike,
    options?: LimitOptions,
  ): TransientErrorInfo | undefined;
}

export function isAutonomousPermissionMode(mode: AgentPermissionMode | undefined): boolean {
  return mode === 'auto' || mode === 'bypassPermissions';
}

/** The permission picker's labels for the modes in which a CLI would ask. */
const ASKING_MODE_LABELS: ReadonlyMap<AgentPermissionMode, string> = new Map([
  ['default', 'Ask'],
  ['acceptEdits', 'Accept edits'],
]);

/**
 * For a CLI that runs a prompt headless (`-p`): nobody can answer its approval questions, so in an
 * asking mode it denies, silently, every action that needs approval. `plan` is read-only by request,
 * and without a prompt the CLI runs interactively.
 */
export function headlessAskProblem(
  displayName: string,
  mode: AgentPermissionMode | undefined,
  hasPrompt: boolean,
): string | null {
  const label = ASKING_MODE_LABELS.get(mode ?? 'default');
  if (!hasPrompt || !label) return null;
  return `${displayName} runs without a terminal to answer in, so in ${label} mode it would refuse every command without telling anyone. Start it in Autonomous mode, or pick another agent.`;
}

/** The prompt framing every CLI without a system-prompt flag shares: role, rules, then the task. */
export function decorateWithPersona(prompt: string, persona: PersonaBrief | undefined): string {
  if (!prompt || !persona) return prompt;
  const rules = persona.rules ? `\n\n${persona.rules}` : '';
  return `[Role: ${persona.roleTitle}]\n${persona.systemPrompt}${rules}\n\n---\nTask:\n${prompt}`;
}
