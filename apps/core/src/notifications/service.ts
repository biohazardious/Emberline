import {
  type NotificationSettings,
  NotificationSettings as NotificationSettingsSchema,
  type QuotaWindow,
  type SchedulerState,
  type TestNotificationResponse,
  type UpdateNotificationSettingsBody,
  UpdateNotificationSettingsBody as UpdateNotificationSettingsBodySchema,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { badRequest } from '../errors.js';
import { providerAdapter } from '../runs/providers.js';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';

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

const laneKey = (w: QuotaWindow) => `${w.agent}|${w.credential}|${w.pool}`;

const CREDENTIAL_LABEL: Record<string, string> = { api_key: ' API key', credits: ' AI credits' };

/** E.g. "Antigravity (all models)", "Claude API key (opus)". */
function laneLabel(w: QuotaWindow): string {
  const adapter = providerAdapter(w.agent);
  const name = adapter.id === w.agent ? adapter.displayName : w.agent;
  return `${name}${CREDENTIAL_LABEL[w.credential] ?? ''} (${w.pool === '*' ? 'all models' : w.pool})`;
}

export class NotificationService {
  /** Open quota windows as of the last scheduler state. */
  private lastWindows: QuotaWindow[] = [];

  constructor(
    private readonly db: Db,
    runs?: RunService,
    scheduler?: Scheduler,
  ) {
    if (scheduler) {
      this.lastWindows = scheduler.state().windows;
      scheduler.on('state', (state) => {
        void this.onSchedulerState(state);
      });
    }
    if (runs) {
      runs.on('run', (run, stateChanged) => {
        if (!stateChanged) return;
        const label = run.title ?? run.branch ?? run.id.slice(0, 8);
        // B14: every session reports waiting_input on SessionStart before its first prompt arrives;
        // that is startup, not an agent waiting on a person.
        if (run.state === 'waiting_input' && run.lastEvent !== 'SessionStart') {
          const cfg = this.getSettings();
          if (cfg.enabled && cfg.onWaitingInput) {
            void this.dispatch(cfg, {
              event: 'waiting_input',
              title: `Agent waiting on you: ${label}`,
              body: `Run "${label}" (${run.lastEvent ?? 'prompt'}) is waiting for your input or permission.`,
              priority: 'high',
              tags: ['hourglass_flowing_sand', 'emberline'],
            });
          }
        } else if ((run.state === 'done' || run.state === 'failed') && !run.cancelled && !run.handedOffTo) {
          const cfg = this.getSettings();
          if (cfg.enabled && cfg.onRunFinished) {
            const failed = run.state === 'failed';
            void this.dispatch(cfg, {
              event: 'run_finished',
              title: failed ? `Run failed: ${label}` : `Run completed: ${label}`,
              body: failed
                ? `Run "${label}" exited with an error.`
                : `Run "${label}" finished its turn and is ready for review.`,
              priority: failed ? 'high' : 'default',
              tags: [failed ? 'x' : 'white_check_mark', 'emberline'],
            });
          }
        }
      });
      // A paused factory waits for a person like an agent does: same switch as waiting_input.
      runs.on('note', (run, type, payload) => {
        if (type !== 'factory_chain_paused') return;
        const cfg = this.getSettings();
        if (!cfg.enabled || !cfg.onWaitingInput) return;
        const label = run.title ?? run.branch ?? run.id.slice(0, 8);
        const message = (payload as { message?: unknown } | null)?.message;
        void this.dispatch(cfg, {
          event: 'factory_paused',
          title: `Factory paused: ${label}`,
          body:
            typeof message === 'string' && message
              ? message
              : 'The factory chain paused after failing ticket runs; fix the cause and click Run pipeline.',
          priority: 'high',
          tags: ['pause_button', 'emberline'],
        });
      });
    }
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
    const row = this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
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

    if (!row || typeof row.value !== 'object' || row.value === null) return defaults;
    const parsed = NotificationSettingsSchema.safeParse({ ...defaults, ...(row.value as object) });
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
    this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: next })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next },
      })
      .run();
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
