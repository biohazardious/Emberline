import type { AgentState, LimitOptions, ProviderAdapter } from '@emberline/adapter-sdk';
import { stateAfterExit } from '@emberline/adapter-sdk';
import type { HookEnvelope, RunEvent, RunState, SessionInfo } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEvents, runs } from '../db/schema.js';
import { notFound } from '../errors.js';

type RunRow = typeof runs.$inferSelect;

/** A run still `starting` without a terminal after this long lost its spawn (e.g. core restarted). */
export const STARTING_WATCHDOG_MS = 3 * 60_000;
/**
 * An unattended run waiting this long on a permission prompt, or since it was found stalled, is
 * stopped as failed (R6).
 */
export const WAITING_INPUT_TIMEOUT_MS = 30 * 60_000;
/**
 * A `working` run, or a `starting` one with a terminal (e.g. a live resume whose CONTINUE produced no
 * hook), with no hook and an unchanged screen this long is taken as stalled (a missed hook, a hung
 * CLI): it becomes `waiting_input`, which frees its slot and pages the user (R7).
 */
export const STALL_WATCHDOG_MS = 20 * 60_000;
/** Whole minutes of a duration, for user-facing copy. */
export const minutesOf = (ms: number) => Math.round(ms / 60_000);
/**
 * Waits before each automatic retry of a turn that died on a temporary provider error (503,
 * overloaded, network). After the last one the run is left for the user as before.
 */
export const AUTO_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
/**
 * An agent idling at its prompt after finishing is closed after this long. Sessions that can be
 * resumed (`claude --resume`) close soon; CLIs without a session id would lose follow-ups, so they
 * stay open much longer (B19).
 */
const IDLE_DONE_RESUMABLE_TTL_MS = 2 * 60_000;
const IDLE_DONE_NON_RESUMABLE_TTL_MS = 30 * 60_000;

/**
 * States in which the CLI sits at its prompt, so text typed by Emberline itself (CONTINUE, nudges,
 * gate follow-ups) is read as the next turn. A rate-limited turn has ended on its limit.
 */
const IDLE_STATES: ReadonlySet<string> = new Set<RunState>(['waiting_input', 'done', 'rate_limited']);

/** Whether a run in `state` sits at its CLI's prompt (see IDLE_STATES). */
export const atPrompt = (state: string): boolean => IDLE_STATES.has(state);

/** How long a finished agent with (or without) a resumable session may idle at its prompt. */
export const idleTtlMs = (row: Pick<RunRow, 'agentSessionId'>): number =>
  row.agentSessionId ? IDLE_DONE_RESUMABLE_TTL_MS : IDLE_DONE_NON_RESUMABLE_TTL_MS;

/** Events that never become a run's `lastEvent`. */
const BOOKKEEPING_EVENT_TYPES = new Set([
  'last_screen',
  'completion_tool_ready',
  // The issue write-back reports on the run; it is not something the run did.
  'issue_commented',
  'issue_comment_failed',
  'issue_closed',
  'issue_close_failed',
  // A compose preview's background start ended; the run did nothing.
  'preview_ready',
  'preview_failed',
  // A person stopped or removed the run's compose project on the Docker page.
  'docker_project_stopped',
  'docker_project_removed',
  // The pipeline's own records: the critic ran, where a shared worktree's outputs went.
  'critic_reviewed',
  'build_outputs_archive_shared',
]);

/** One event of a run, with the state it moves the run to and the columns it changes. */
export interface RunEventInput {
  source: RunEvent['source'];
  type: string;
  state?: AgentState;
  payload?: unknown;
  patch?: Partial<RunRow>;
}

/**
 * Appends an event and applies its state change and patch in one transaction. `changed`: the
 * state moved (a repeat of the current state is no transition and is not stored on the event).
 */
export function applyRunEvent(db: Db, id: string, event: RunEventInput): { row: RunRow; changed: boolean } {
  const now = new Date();
  let changed = false;
  const row = db.transaction((tx) => {
    const current = tx.select().from(runs).where(eq(runs.id, id)).get();
    if (!current) throw notFound('no such run');
    changed = event.state !== undefined && event.state !== current.state;
    tx.insert(runEvents)
      .values({
        runId: id,
        ts: now,
        source: event.source,
        type: event.type,
        state: changed ? event.state : null,
        payload: event.payload ?? null,
      })
      .run();
    // Bookkeeping (a saved screen, the tool check-in) is not something the run did: it does not
    // become its last event (a waiting run's `SessionStart` must stay its last event, for example).
    const set: Partial<RunRow> = {
      ...event.patch,
      lastEvent: BOOKKEEPING_EVENT_TYPES.has(event.type) ? current.lastEvent : event.type,
    };
    if (changed) Object.assign(set, { state: event.state, stateChangedAt: now });
    return tx.update(runs).set(set).where(eq(runs.id, id)).returning().get();
  });
  return { row, changed };
}

/** What a hook's temporary provider error does to the turn's automatic retries. */
export type RetryPlan =
  | { kind: 'none' }
  | { kind: 'scheduled'; attempt: number; at: Date; reason: string }
  | { kind: 'gave_up'; attempts: number; reason: string };

/** A hook's effect on its run: the next state (undefined: unchanged), the columns, the retries. */
export interface HookTransition {
  next: AgentState | undefined;
  patch: Partial<RunRow>;
  retry: RetryPlan;
}

/**
 * The state machine's step for one hook. A late hook (e.g. SessionEnd after a kill) never revives
 * an ended or stopped run. A temporary provider error waits as `rate_limited` (no slot, no quota
 * window) for the scheduler's retry, a few times with growing delays; a finished turn resets them.
 */
export function hookTransition(
  row: RunRow,
  envelope: Pick<HookEnvelope, 'event' | 'payload'>,
  provider: ProviderAdapter,
  limits: LimitOptions,
  live: boolean,
  now = Date.now(),
): HookTransition {
  const patch: Partial<RunRow> = {};
  let next = live
    ? provider.nextState(row.state as AgentState, envelope.event, envelope.payload, limits)
    : undefined;
  const transient = live
    ? provider.transientErrorFromHook(envelope.event, envelope.payload, limits)
    : undefined;
  let retry: RetryPlan = { kind: 'none' };
  if (transient && row.autoRetryCount < AUTO_RETRY_DELAYS_MS.length) {
    const attempt = row.autoRetryCount + 1;
    const at = new Date(now + (AUTO_RETRY_DELAYS_MS[attempt - 1] ?? 0));
    retry = { kind: 'scheduled', attempt, at, reason: transient.message };
    next = row.state === 'rate_limited' ? undefined : 'rate_limited';
    patch.autoRetryCount = attempt;
    patch.autoRetryAt = at;
  } else {
    if (envelope.event === 'Stop' && (row.autoRetryCount > 0 || row.autoRetryAt)) {
      patch.autoRetryCount = 0;
      patch.autoRetryAt = null;
    }
    if (transient) retry = { kind: 'gave_up', attempts: row.autoRetryCount, reason: transient.message };
  }
  return { next, patch, retry };
}

/**
 * How a stop request ends a run. `cancel`: queued, or waiting out its quota without a session; it
 * fails at once. `ended`: nothing to do. `cancel_setup`: still in its worktree setup, with no agent
 * yet; the setup command is killed. `kill`: the agent (or its spawn) is stopped and reconcile
 * records the end.
 */
export type StopTransition =
  | { kind: 'cancel' }
  | { kind: 'ended' }
  | { kind: 'cancel_setup' }
  | { kind: 'kill'; sessionId: string | null };

export function stopTransition(
  row: Pick<RunRow, 'state' | 'ptydSessionId' | 'endedAt'>,
  settingUp: boolean,
): StopTransition {
  const live = Boolean(row.ptydSessionId && !row.endedAt);
  if (row.state === 'queued' || (!live && row.state === 'rate_limited')) return { kind: 'cancel' };
  if (row.endedAt) return { kind: 'ended' };
  if (settingUp && !row.ptydSessionId) return { kind: 'cancel_setup' };
  return { kind: 'kill', sessionId: row.ptydSessionId };
}

/** The end of a run whose session exited (`session`, as the runner listed it) or is gone (undefined). */
export interface ExitTransition {
  state: AgentState;
  event: 'cancelled' | 'process_exited' | 'session_lost';
  exitCode: number | null;
  /** The process failed on its own: its last screen lines say why. */
  explain: boolean;
}

export function exitTransition(
  row: Pick<RunRow, 'state' | 'cancelledAt'>,
  session: SessionInfo | undefined,
): ExitTransition {
  const exitCode = session ? session.exitCode : null;
  const state: AgentState = row.cancelledAt
    ? row.state === 'done'
      ? 'done'
      : 'failed'
    : stateAfterExit(row.state as AgentState, exitCode);
  return {
    state,
    event: row.cancelledAt ? 'cancelled' : session ? 'process_exited' : 'session_lost',
    exitCode,
    explain: Boolean(session) && state === 'failed' && !row.cancelledAt,
  };
}

/** What reconcile does with an open run on this pass. */
export type OpenRunStep =
  /** No session and a final state: the run's end is recorded. */
  | { kind: 'close' }
  /** No session yet: still spawning or queued. */
  | { kind: 'spawning' }
  /** Working (or starting) in a live session: the stall watchdog looks at it. */
  | { kind: 'watch' }
  /** Unattended and waiting past WAITING_INPUT_TIMEOUT_MS: stopped as failed. */
  | { kind: 'waiting_timeout'; reason: 'Notification' | 'stall_detected' }
  /** Finished and idle at its prompt past its TTL: the session is closed (rechecked under the lock). */
  | { kind: 'idle'; ttlMs: number }
  /** Live and nothing to do. */
  | { kind: 'keep' }
  /** Its session exited or is gone: the end is recorded. */
  | { kind: 'session_ended' };

/** The facts about a run that reconcile reads from its events only when a step needs them. */
export interface OpenRunFacts {
  waitingReason(): 'Notification' | 'stall_detected' | undefined;
  unattended(): boolean;
  pipelineBusy: boolean;
}

export function openRunStep(
  row: RunRow,
  session: SessionInfo | undefined,
  nowMs: number,
  facts: OpenRunFacts,
): OpenRunStep {
  if (!row.ptydSessionId) {
    return row.state === 'done' || row.state === 'failed' ? { kind: 'close' } : { kind: 'spawning' };
  }
  if (session?.status !== 'running') return { kind: 'session_ended' };
  if (row.state === 'working' || row.state === 'starting') return { kind: 'watch' };
  const waitingOn =
    row.state === 'waiting_input' && nowMs - row.stateChangedAt.getTime() > WAITING_INPUT_TIMEOUT_MS
      ? facts.waitingReason()
      : undefined;
  if (waitingOn && facts.unattended()) return { kind: 'waiting_timeout', reason: waitingOn };
  const ttlMs = idleTtlMs(row);
  if (row.state === 'done' && nowMs - row.stateChangedAt.getTime() > ttlMs && !facts.pipelineBusy) {
    return { kind: 'idle', ttlMs };
  }
  return { kind: 'keep' };
}
