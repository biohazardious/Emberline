/**
 * Agent adapter contract (PROJECT.md §5.3).
 *
 * An adapter turns a generic "run" into a concrete agent CLI session hosted by ptyd and
 * translates whatever signals that CLI emits (hooks, transcripts, screen output) into the
 * normalized {@link AgentState} / {@link AgentEvent} model the scheduler and board use.
 */

export type AgentState =
  /** Waiting for a free slot and available quota; no process yet. */
  | 'queued'
  | 'starting'
  | 'working'
  /** The agent needs a prompt or a permission decision from the user. */
  | 'waiting_input'
  | 'rate_limited'
  | 'done'
  | 'failed';

export type AgentEventSource = 'hook' | 'transcript' | 'screen' | 'user' | 'system';

export interface AgentEvent {
  runId: string;
  ts: string;
  source: AgentEventSource;
  type: string;
  /** Present when the event changes the derived agent state. */
  state?: AgentState;
  /** For `rate_limited`: when the usage window resets, if it could be determined. */
  resetsAt?: string;
  payload?: unknown;
}

export interface RunContext {
  runId: string;
  projectId: string;
  ticketId: string;
  /** Absolute path of the git worktree the agent works in. */
  worktreePath: string;
  /** Initial task prompt. */
  prompt: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface SessionRef {
  runId: string;
  ptydSessionId: string;
  /** Agent-native session id (e.g. Claude's session_id), used for resume. */
  agentSessionId?: string;
}

export type Unsubscribe = () => void;

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  start(ctx: RunContext): Promise<SessionRef>;
  send(session: SessionRef, input: string): Promise<void>;
  state(session: SessionRef): AgentState;
  onEvent(cb: (event: AgentEvent) => void): Unsubscribe;
  /** Continue after a rate limit or crash. May return a new ref if the process was respawned. */
  resume(session: SessionRef): Promise<SessionRef>;
  stop(session: SessionRef): Promise<void>;
}

/** States after which a run never transitions on its own. */
export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['done', 'failed']);

/**
 * How to start an agent CLI. Core hands this to ptyd unchanged, which keeps adapters free of
 * any transport dependency (and lets out-of-process adapters return it over RPC later).
 */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** Merged over ptyd's minimal base environment. */
  env: Record<string, string>;
}
