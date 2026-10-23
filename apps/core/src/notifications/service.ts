import {
  type NotificationSettings,
  NotificationSettings as NotificationSettingsSchema,
  type QuotaWindow,
  type Run,
  type SchedulerState,
  type TestNotificationResponse,
  type UpdateNotificationSettingsBody,
  UpdateNotificationSettingsBody as UpdateNotificationSettingsBodySchema,
} from '@emberline/protocol';
import { and, eq, lt, max } from 'drizzle-orm';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { notificationLog, runEvents } from '../db/schema.js';
import { badRequest } from '../errors.js';
import { providerAdapter } from '../runs/providers.js';
import { minutesOf, type RunService, STALL_WATCHDOG_MS, WAITING_INPUT_TIMEOUT_MS } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';
import type { PresenceRegistry } from './presence.js';

const SETTINGS_KEY = 'notifications.config';

/**
 * HTTP header values must be Latin-1 (fetch throws otherwise). ntfy accepts RFC 2047
 * encoded-words, so anything outside printable ASCII is sent as `=?UTF-8?B?...?=`.
 */
export function encodeHeaderValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

export interface NotificationMessage {
  event: 'rate_limited' | 'quota_resumed' | 'waiting_input' | 'run_finished' | 'factory_paused' | 'test';
  title: string;
  body: string;
  priority?: 'default' | 'high';
  tags?: string[];
}

/** A page quotes the start of the agent's text; the Inbox shows all of it. */
export const PAGE_BODY_MAX = 300;

/** The page text for a run that needs a person, from its attention, at most PAGE_BODY_MAX characters. */
function waitingBody(label: string, run: Run, attention: NonNullable<Run['attention']>): string {
  const body = waitingText(label, run, attention);
  return body.length > PAGE_BODY_MAX ? `${body.slice(0, PAGE_BODY_MAX - 1)}…` : body;
}

function waitingText(label: string, run: Run, attention: NonNullable<Run['attention']>): string {
  const detail = attention.detail;
  switch (attention.reason) {
    case 'stalled':
      return `Run "${label}" showed no activity for ${minutesOf(STALL_WATCHDOG_MS)} minutes and may be stuck. Have a look at its terminal.`;
    case 'blocked': {
      const items = (detail ?? '').split('\n').filter(Boolean);
      return `Run "${label}" cannot finish its ticket and needs you:${items.length > 0 ? items.map((b) => `\n- ${b}`).join('') : ' no details given.'}`;
    }
    case 'held':
      return `Run "${label}" is held for you${detail ? `: ${detail}` : ''}. The ticket stays in Review until you answer it.`;
    default:
      return `Run "${label}" (${run.lastEvent ?? 'prompt'}) is waiting for your input or permission.${detail ? `\n${detail}` : ''}`;
  }
}

const laneKey = (w: QuotaWindow) => `${w.agent}|${w.credential}|${w.pool}`;

const CREDENTIAL_LABEL: Record<string, string> = { api_key: ' API key', credits: ' AI credits' };

/** E.g. "Antigravity (all models)", "Claude API key (opus)". */
function laneLabel(w: QuotaWindow): string {
  const adapter = providerAdapter(w.agent);
  const name = adapter.id === w.agent ? adapter.displayName : w.agent;
  return `${name}${CREDENTIAL_LABEL[w.credential] ?? ''} (${w.pool === '*' ? 'all models' : w.pool})`;
}

/** A failed page is tried once more after this long, then dropped. */
export const PAGE_RETRY_MS = 60_000;
/** `notification_log` rows older than this are pruned. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

export interface NotificationServiceOptions {
  /** Who is looking at which run; a page for a run someone is looking at is suppressed. */
  presence?: Pick<PresenceRegistry, 'isWatched'>;
  retryDelayMs?: number;
  now?: () => number;
  /** Where a failure inside a listener goes (core's logger); console by default. */
  log?: (message: string, error: unknown) => void;
}

/** The part of a page that depends on what happened; the rest (log, presence, retry) is shared. */
interface Page {
  occurrence: string;
  runId: string;
  message: NotificationMessage;
  /** ISO time the attention began; a page older than this service's start is not sent. */
  since?: string;
  /** Whether the settings still want this page (checked again before a retry). */
  wanted: (cfg: NotificationSettings) => boolean;
  /** Set when `occurrence` is the run's `attention.occurrence`: a retry then needs it to be current. */
  attention?: boolean;
}

export class NotificationService {
  /** Open quota windows as of the last scheduler state. */
  private lastWindows: QuotaWindow[] = [];
  private readonly presence?: Pick<PresenceRegistry, 'isWatched'>;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, error: unknown) => void;
  /** Attention that began before this moment predates this process; see {@link page}. */
  private readonly startedAt: number;
  private readonly retries = new Set<NodeJS.Timeout>();
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly runs?: RunService,
    scheduler?: Scheduler,
    options: NotificationServiceOptions = {},
  ) {
    this.presence = options.presence;
    this.retryDelayMs = options.retryDelayMs ?? PAGE_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message, error) => console.error(message, error));
    this.startedAt = this.now();
    if (scheduler) {
      this.lastWindows = scheduler.state().windows;
      scheduler.on('state', (state) => {
        void this.onSchedulerState(state);
      });
    }
    if (runs) {
      runs.on('run', (emitted, stateChanged) => {
        // Never throws into the emitter (a DB error must not escape RunService.record).
        try {
          // In-process payloads carry no attention; computed once per emit, shared with the events socket.
          this.onRun(runs.attentionOf(emitted), stateChanged);
        } catch (error) {
          this.log('notification: handling a run event failed', error);
        }
      });
      // A paused factory waits for a person like an agent does: same switch as waiting_input.
      runs.on('note', (run, type, payload) => {
        if (type !== 'factory_chain_paused') return;
        try {
          this.onFactoryPaused(run, payload);
        } catch (error) {
          this.log('notification: handling a factory pause failed', error);
        }
      });
    }
  }

  private onFactoryPaused(run: Run, payload: unknown): void {
    const cfg = this.getSettings();
    if (!cfg.enabled || !cfg.onWaitingInput) return;
    const label = run.title ?? run.branch ?? run.id.slice(0, 8);
    const message = (payload as { message?: unknown } | null)?.message;
    this.send(cfg, {
      occurrence: `${run.projectId}:factory_paused:${this.latestEventId(run.id)}`,
      runId: run.id,
      wanted: (c) => c.onWaitingInput,
      message: {
        event: 'factory_paused',
        title: `Factory paused: ${label}`,
        body:
          typeof message === 'string' && message
            ? message
            : 'The factory chain paused after failing ticket runs; fix the cause and click Run pipeline.',
        priority: 'high',
        tags: ['pause_button', 'emberline'],
      },
    });
  }

  /** Starts the daily pruning of the page log. */
  start(): void {
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
    this.pruneTimer.unref();
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  /** Drops log rows older than {@link LOG_RETENTION_MS}. */
  prune(): void {
    this.db
      .delete(notificationLog)
      .where(lt(notificationLog.sentAt, new Date(this.now() - LOG_RETENTION_MS)))
      .run();
  }

  /** Id of the run's newest event, the stable part of an occurrence that has no event of its own. */
  private latestEventId(runId: string): number | string {
    try {
      const row = this.db
        .select({ id: max(runEvents.id) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get();
      return row?.id ?? `t${this.now()}`;
    } catch {
      return `t${this.now()}`;
    }
  }

  /** Id of the event that moved the run to its current state. */
  private stateEventId(runId: string, state: string, stateChangedAt: string): number | string {
    try {
      const row = this.db
        .select({ id: max(runEvents.id) })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.state, state)))
        .get();
      return row?.id ?? `t${Date.parse(stateChangedAt)}`;
    } catch {
      return `t${Date.parse(stateChangedAt)}`;
    }
  }

  /** A run changed: page for a new attention occurrence, and (opt-in) for a finished run. */
  private onRun(run: Run, stateChanged: boolean): void {
    const label = run.title ?? run.branch ?? run.id.slice(0, 8);
    const attention = run.attention;
    if (attention && attention.reason !== 'rate_limited') {
      const cfg = this.getSettings();
      if (!cfg.enabled) return;
      if (attention.reason === 'failed') {
        // Failures page under the finished-runs switch, once, when the run fails.
        if (stateChanged && cfg.onRunFinished) {
          const timedOut = run.lastEvent === 'waiting_input_timeout';
          this.send(cfg, {
            occurrence: attention.occurrence,
            runId: run.id,
            since: attention.since,
            attention: true,
            wanted: (c) => c.onRunFinished,
            message: {
              event: 'run_finished',
              title: timedOut ? `Run stopped, no one answered: ${label}` : `Run failed: ${label}`,
              body: timedOut
                ? `Run "${label}" waited ${minutesOf(WAITING_INPUT_TIMEOUT_MS)} minutes on a permission prompt or a stalled turn with nobody there, so it was stopped.`
                : `Run "${label}" exited with an error.`,
              priority: 'high',
              tags: ['x', 'emberline'],
            },
          });
        }
        return;
      }
      if (!cfg.onWaitingInput) return;
      this.send(cfg, {
        occurrence: attention.occurrence,
        runId: run.id,
        since: attention.since,
        attention: true,
        wanted: (c) => c.onWaitingInput,
        message: {
          event: 'waiting_input',
          title: `Agent waiting on you: ${label}`,
          body: waitingBody(label, run, attention),
          priority: 'high',
          tags: ['hourglass_flowing_sand', 'emberline'],
        },
      });
      return;
    }
    if (stateChanged && run.state === 'done' && !run.cancelled && !run.handedOffTo) {
      const cfg = this.getSettings();
      if (!cfg.enabled || !cfg.onRunFinished) return;
      this.send(cfg, {
        occurrence: `${run.id}:finished:${this.stateEventId(run.id, 'done', run.stateChangedAt)}`,
        runId: run.id,
        wanted: (c) => c.onRunFinished,
        message: {
          event: 'run_finished',
          title: `Run completed: ${label}`,
          body: `Run "${label}" finished its turn and is ready for review.`,
          priority: 'default',
          tags: ['white_check_mark', 'emberline'],
        },
      });
    }
  }

  /** Fire and forget: a failure is logged, never thrown into the run's event flow. */
  private send(cfg: NotificationSettings, page: Page): void {
    this.page(cfg, page).catch((error) => this.log('notification: paging failed', error));
  }

  /**
   * Sends one page unless its occurrence is logged already (sent, suppressed or failed: never twice,
   * restarts included), someone is looking at that run, or the attention began before this process
   * started (an upgrade or restart does not re-announce old waits; hooks and holds only arise while
   * core runs, so nothing real is lost). The row is written BEFORE the send: at-most-once, a crash can
   * lose a page but never double it. A failed send is retried once after {@link PAGE_RETRY_MS}, if it
   * is still wanted by then.
   */
  private async page(cfg: NotificationSettings, page: Page): Promise<void> {
    const old = page.since !== undefined && Date.parse(page.since) < this.startedAt;
    const hidden = old || (this.presence?.isWatched(page.runId) ?? false);
    const inserted = this.db
      .insert(notificationLog)
      .values({
        occurrence: page.occurrence,
        event: page.message.event,
        sentAt: new Date(this.now()),
        outcome: hidden ? 'suppressed' : 'sent',
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0 || hidden) return;
    const result = await this.dispatch(cfg, page.message);
    if (result.ok) return;
    this.setOutcome(page.occurrence, 'failed');
    const timer = setTimeout(() => {
      this.retries.delete(timer);
      try {
        this.retry(page);
      } catch (error) {
        this.log('notification: retry failed', error);
      }
    }, this.retryDelayMs);
    timer.unref();
    this.retries.add(timer);
  }

  /** The one retry: sends only if the page is still wanted, still current and nobody is looking. */
  private retry(page: Page): void {
    const current = this.getSettings();
    if (!current.enabled || !page.wanted(current)) return;
    if (page.attention) {
      let now: string | undefined;
      try {
        now = this.runs?.getRun(page.runId).attention?.occurrence;
      } catch {
        return; // the run is gone
      }
      if (now !== page.occurrence) return;
    }
    if (this.presence?.isWatched(page.runId)) {
      this.setOutcome(page.occurrence, 'suppressed');
      return;
    }
    void this.dispatch(current, page.message)
      .then((retry) => {
        if (retry.ok) this.setOutcome(page.occurrence, 'sent');
      })
      .catch((error) => this.log('notification: retry failed', error));
  }

  private setOutcome(occurrence: string, outcome: 'sent' | 'suppressed' | 'failed'): void {
    this.db.update(notificationLog).set({ outcome }).where(eq(notificationLog.occurrence, occurrence)).run();
  }

  /**
   * One page per quota lane that runs out, and one when it is back; other lanes keep running
   * meanwhile. A window is the same limit while its id or its lane lives on: a window refined in
   * place to one model pool (same id, other lane) or replaced on its lane (new id) pages nothing.
   */
  private async onSchedulerState(state: SchedulerState): Promise<void> {
    const prev = this.lastWindows;
    const next = state.windows;
    this.lastWindows = next;
    const known = (windows: QuotaWindow[]) => {
      const ids = new Set(windows.map((w) => w.id));
      const lanes = new Set(windows.map(laneKey));
      return (w: QuotaWindow) => ids.has(w.id) || lanes.has(laneKey(w));
    };
    const wasOpen = known(prev);
    const isOpen = known(next);

    const cfg = this.getSettings();
    if (!cfg.enabled) return;

    for (const window of next) {
      if (wasOpen(window) || !cfg.onRateLimited) continue;
      const resumeAt = new Date(window.resumeAt).toLocaleTimeString();
      const resetNote = window.resetsAt
        ? `Resets at ${new Date(window.resetsAt).toLocaleTimeString()}.`
        : `Reset time unknown; probing again at ${resumeAt}.`;
      await this.dispatch(cfg, {
        event: 'rate_limited',
        title: `${laneLabel(window)} quota reached`,
        body: `${window.message ? `${window.message}\n` : ''}Its runs wait until ${resumeAt}; other providers keep running. ${resetNote}`,
        priority: 'default',
        tags: ['warning', 'emberline'],
      });
    }
    for (const window of prev) {
      if (isOpen(window) || !cfg.onQuotaResumed) continue;
      await this.dispatch(cfg, {
        event: 'quota_resumed',
        title: `${laneLabel(window)} quota is back`,
        body: `Its runs resume. Active slots: ${state.busy}/${state.maxConcurrentRuns}, queued: ${state.queued}.`,
        priority: 'default',
        tags: ['rocket', 'emberline'],
      });
    }
  }

  getSettings(): NotificationSettings {
    const stored = getSetting<unknown>(this.db, SETTINGS_KEY);
    const defaultUrl = process.env.EMBERLINE_NOTIFY_URL?.trim() ?? '';
    const defaultProvider = process.env.EMBERLINE_NOTIFY_PROVIDER === 'webhook' ? 'webhook' : 'ntfy';
    const defaultToken = process.env.EMBERLINE_NOTIFY_TOKEN?.trim() || null;

    const defaults: NotificationSettings = {
      enabled: Boolean(defaultUrl),
      provider: defaultProvider,
      url: defaultUrl,
      token: defaultToken,
      onRateLimited: true,
      onQuotaResumed: true,
      onWaitingInput: true,
      onRunFinished: false,
    };

    if (typeof stored !== 'object' || stored === null) return defaults;
    const parsed = NotificationSettingsSchema.safeParse({ ...defaults, ...stored });
    return parsed.success ? parsed.data : defaults;
  }

  updateSettings(input: UpdateNotificationSettingsBody): NotificationSettings {
    const parsed = UpdateNotificationSettingsBodySchema.safeParse(input);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'invalid notification settings');
    }
    const current = this.getSettings();
    const next: NotificationSettings = {
      ...current,
      ...parsed.data,
    };
    if (next.enabled && !next.url.trim()) {
      throw badRequest('notification URL is required when notifications are enabled');
    }
    if (next.url.trim()) {
      try {
        const u = new URL(next.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('protocol must be http or https');
        }
      } catch {
        throw badRequest('notification URL must be a valid http(s) URL');
      }
    }
    setSetting(this.db, SETTINGS_KEY, next);
    return next;
  }

  async sendTest(): Promise<TestNotificationResponse> {
    const cfg = this.getSettings();
    if (!cfg.url.trim()) {
      throw badRequest('configure a notification URL first');
    }
    return this.dispatch(cfg, {
      event: 'test',
      title: 'Emberline test notification',
      body: 'Notifications are connected and working.',
      priority: 'default',
      tags: ['fire', 'emberline'],
    });
  }

  async dispatch(cfg: NotificationSettings, msg: NotificationMessage): Promise<TestNotificationResponse> {
    if (!cfg.url.trim()) {
      return { ok: false, status: null, error: 'empty URL' };
    }
    const headers: Record<string, string> = {};
    if (cfg.token) {
      headers.Authorization = `Bearer ${cfg.token}`;
    }

    try {
      let body: string;
      if (cfg.provider === 'ntfy') {
        headers.Title = encodeHeaderValue(msg.title);
        headers.Priority = msg.priority ?? 'default';
        if (msg.tags?.length) headers.Tags = encodeHeaderValue(msg.tags.join(','));
        body = msg.body;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          event: msg.event,
          title: msg.title,
          message: msg.body,
          // Discord & Slack webhook compatibility fields
          content: `**${msg.title}**\n${msg.body}`,
          text: `*${msg.title}*\n${msg.body}`,
          timestamp: new Date().toISOString(),
        });
      }

      const res = await fetch(cfg.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: `HTTP ${res.status}`,
        };
      }
      return { ok: true, status: res.status, error: null };
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
