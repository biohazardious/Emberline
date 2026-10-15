import {
  type NotificationSettings,
  NotificationSettings as NotificationSettingsSchema,
  type SchedulerState,
  type TestNotificationResponse,
  type UpdateNotificationSettingsBody,
  UpdateNotificationSettingsBody as UpdateNotificationSettingsBodySchema,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { badRequest } from '../errors.js';
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
  event: 'rate_limited' | 'quota_resumed' | 'waiting_input' | 'run_finished' | 'test';
  title: string;
  body: string;
  priority?: 'default' | 'high';
  tags?: string[];
}

export class NotificationService {
  private lastWindowId: string | null = null;

  constructor(
    private readonly db: Db,
    runs?: RunService,
    scheduler?: Scheduler,
  ) {
    if (scheduler) {
      this.lastWindowId = scheduler.state().window?.id ?? null;
      scheduler.on('state', (state) => {
        void this.onSchedulerState(state);
      });
    }
    if (runs) {
      runs.on('run', (run, stateChanged) => {
        if (!stateChanged) return;
        const label = run.title ?? run.branch ?? run.id.slice(0, 8);
        if (run.state === 'waiting_input') {
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
        } else if (run.state === 'done' || run.state === 'failed') {
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
    }
  }

  private async onSchedulerState(state: SchedulerState): Promise<void> {
    const prevId = this.lastWindowId;
    const nextWindow = state.window;
    this.lastWindowId = nextWindow?.id ?? null;

    const cfg = this.getSettings();
    if (!cfg.enabled) return;

    if (!prevId && nextWindow && cfg.onRateLimited) {
      const resetNote = nextWindow.resetsAt
        ? `Resets at ${new Date(nextWindow.resetsAt).toLocaleTimeString()} (auto-resume scheduled at ${new Date(
            nextWindow.resumeAt,
          ).toLocaleTimeString()}).`
        : `Reset time unknown; probing again at ${new Date(nextWindow.resumeAt).toLocaleTimeString()}.`;
      await this.dispatch(cfg, {
        event: 'rate_limited',
        title: 'Claude quota limit reached — dispatch paused',
        body: `${nextWindow.message ? `${nextWindow.message}\n` : ''}${resetNote}`,
        priority: 'default',
        tags: ['warning', 'emberline'],
      });
    } else if (prevId && !nextWindow && cfg.onQuotaResumed) {
      await this.dispatch(cfg, {
        event: 'quota_resumed',
        title: 'Claude quota window reset — runs resumed',
        body: `Quota pause ended. Active slots: ${state.busy}/${state.maxConcurrentRuns}, queued: ${state.queued}.`,
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
