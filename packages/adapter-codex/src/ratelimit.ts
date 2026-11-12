/**
 * Usage-limit detection for Codex CLI (docs/DESIGN.md §3.5), in signal order:
 *
 * 1. Hook: the wrapper's `StopFailure` carries the end of `codex exec` output, e.g.
 *      "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex
 *       (https://chatgpt.com/explore/plus), or try again at 3:42 PM."
 *      "... visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 14th, 2026 9:05 AM."
 *    Codex prints the reset in the runner's local time: "%-I:%M %p" the same day, else
 *    "%b %-d<st|nd|rd|th>, %Y %-I:%M %p". Older builds said "try again in 2 days 3 hours 15 minutes".
 * 2. Transcript: the same hook carries the run's own session rollout's latest `rate_limits` record
 *    (`~/.codex/sessions/.../rollout-*.jsonl`): a window at 100% gives the reset (`resets_at` epoch
 *    seconds; older builds `resets_in_seconds`) when the text has none. Only a recent record with a
 *    reset still ahead counts, and never over failure text that names a sign-in or other permanent
 *    error: a full window then is not why the run died.
 * 3. Screen: the TUI's "■ You've hit your usage limit. ..." line.
 *
 * "Quota exceeded. Check your plan and billing details." (API `insufficient_quota`) and the credit
 * messages are billing problems: they never reset, so they are no limit.
 */
import {
  hour24,
  type HookPayloadLike,
  isGenericLimit,
  isPermanentErrorText,
  isTransientErrorText,
  joinFields,
  lastLimitOnScreen,
  type LimitOptions,
  limitSentence,
  monthIndex,
  oneLine,
  parseDurationMs,
  type RateLimitInfo,
  resolveWallClock,
  type TransientErrorInfo,
  transcriptTail,
  WRAPPER_FAILURE_FIELDS,
} from '@emberline/adapter-sdk';

/** Codex's usage-limit wording (every plan's variant of `UsageLimitReachedError`). */
const LIMIT_PATTERN = /you'?ve (?:hit|reached) your usage limit|\busage limit reached\b/i;

/** The retry loop giving up on HTTP 429 ("exceeded retry limit, last status: 429 Too Many Requests"). */
const RETRY_429_PATTERN = /exceeded retry limit,? last status:? 429/i;

/** Billing and credit problems: no reset will fix them. */
const BILLING_PATTERN =
  /quota exceeded\.? check your plan and billing|insufficient_quota|out of credits|workspace credit limit/i;

/** Codex service errors a later retry usually gets past. */
const CODEX_TRANSIENT_PATTERN =
  /experiencing high (?:load|demand)|stream disconnected before completion|selected model is at capacity|capacity (?:is )?unavailable/i;

/** "usage limit for gpt-5-codex": a limit on one model only. */
const MODEL_LIMIT = /usage limit for ([\w.-]+)/i;

export function isCodexLimitText(text: string): boolean {
  return LIMIT_PATTERN.test(text) || RETRY_429_PATTERN.test(text);
}

/**
 * The reset time of a Codex limit message: "try again at 3:42 PM", "try again at Nov 14th, 2026
 * 9:05 AM" (local time, read in `timeZone`), or "try again in 2 days 3 hours 15 minutes" / "in 2.5s".
 */
export function parseCodexResetTime(text: string, options: LimitOptions = {}): Date | undefined {
  const now = options.now ?? new Date();
  const at =
    /try again at\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(
      text,
    );
  if (at) {
    const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = at;
    const hour = hour24(hourText ?? '', meridiem);
    if (hour === undefined) return undefined;
    return resolveWallClock(
      {
        hour,
        minute: Number(minuteText),
        ...(monthName && dayText
          ? { month: monthIndex(monthName), day: Number(dayText), year: Number(yearText) }
          : {}),
      },
      now,
      options.timeZone,
    );
  }
  const within = /try again in\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  const ms = within ? parseDurationMs(within[1] ?? '') : undefined;
  return ms === undefined ? undefined : new Date(now.getTime() + ms);
}

interface RateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

function readWindow(value: unknown, base: Date): RateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = numberField(value, 'used_percent');
  if (usedPercent === undefined) return undefined;
  const resetsAtEpoch = numberField(value, 'resets_at');
  const resetsIn = numberField(value, 'resets_in_seconds');
  const resetsAt =
    resetsAtEpoch !== undefined
      ? new Date(resetsAtEpoch * 1000)
      : resetsIn !== undefined
        ? new Date(base.getTime() + resetsIn * 1000)
        : undefined;
  return { usedPercent, windowMinutes: numberField(value, 'window_minutes'), resetsAt };
}

/** "5-hour", "weekly" or "300-minute": how Codex names a window. */
function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'usage';
  if (minutes === 10_080) return 'weekly';
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** How old a rollout record may be and still state the account's limits at the failure. */
export const CODEX_TRANSCRIPT_MAX_AGE_MS = 60 * 60_000;

/**
 * A full window in a Codex rollout record (one JSONL line with `rate_limits`, as an `event_msg`
 * `token_count` payload or at the top level). When both windows are full, the later reset wins.
 * A record without a timestamp, older than {@link CODEX_TRANSCRIPT_MAX_AGE_MS}, or whose full
 * windows have already reset says nothing about now.
 */
export function rateLimitFromCodexTranscript(
  line: string,
  options: LimitOptions = {},
): RateLimitInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const payload = isRecord(parsed.payload) ? parsed.payload : parsed;
  const limits = payload.rate_limits;
  if (!isRecord(limits)) return undefined;
  const stamped = typeof parsed.timestamp === 'string' ? new Date(parsed.timestamp) : undefined;
  if (!stamped || Number.isNaN(stamped.getTime())) return undefined;
  const now = (options.now ?? new Date()).getTime();
  if (now - stamped.getTime() > CODEX_TRANSCRIPT_MAX_AGE_MS) return undefined;
  const full = [readWindow(limits.primary, stamped), readWindow(limits.secondary, stamped)]
    .filter(
      (w): w is RateLimitWindow & { resetsAt: Date } =>
        w !== undefined && w.usedPercent >= 100 && w.resetsAt !== undefined && w.resetsAt.getTime() > now,
    )
    .sort((a, b) => b.resetsAt.getTime() - a.resetsAt.getTime());
  const window = full[0];
  if (!window) return undefined;
  return {
    message: `Codex ${windowLabel(window.windowMinutes)} limit reached`,
    resetsAt: window.resetsAt,
    pool: '*',
  };
}

function poolFor(text: string, options: LimitOptions): string {
  const model = MODEL_LIMIT.exec(text)?.[1];
  return model && model === options.model ? model : '*';
}

/**
 * The usage limit a wrapper `StopFailure` reports: Codex's own wording or an explicit 429 in the
 * output, else a full window in the rollout excerpt, unless the output names a permanent error
 * (sign-in, bad request): that error is the failure to surface. The output's reset time wins over
 * the transcript's.
 */
export function rateLimitFromCodexHook(
  event: string,
  payload: HookPayloadLike,
  options: LimitOptions = {},
): RateLimitInfo | undefined {
  if (event !== 'StopFailure') return undefined;
  const text = joinFields(payload, WRAPPER_FAILURE_FIELDS);
  if (BILLING_PATTERN.test(text)) return undefined;
  const fromText = isCodexLimitText(text) || isGenericLimit(text);
  if (!fromText && isPermanentErrorText(text)) return undefined;
  const fromTranscript = rateLimitFromCodexTranscript(transcriptTail(payload), options);
  if (!fromText) return fromTranscript;
  return {
    message: oneLine(limitSentence(text, [LIMIT_PATTERN, RETRY_429_PATTERN]).replace(/^error:\s*/i, '')),
    resetsAt: parseCodexResetTime(text, options) ?? fromTranscript?.resetsAt,
    pool: poolFor(text, options),
  };
}

/** The last Codex limit line on a terminal snapshot; the reset may wrap onto the next line. */
export function rateLimitFromCodexScreen(
  ansi: string,
  options: LimitOptions = {},
): RateLimitInfo | undefined {
  const found = lastLimitOnScreen(ansi, isCodexLimitText);
  if (!found || BILLING_PATTERN.test(found.text)) return undefined;
  return {
    message: oneLine(limitSentence(found.text, [LIMIT_PATTERN, RETRY_429_PATTERN])),
    resetsAt: parseCodexResetTime(found.text, options),
    pool: poolFor(found.text, options),
  };
}

/** A Codex turn that died on an outage or overload rather than a limit or a billing problem. */
export function transientErrorFromCodexHook(
  event: string,
  payload: HookPayloadLike,
  options: LimitOptions = {},
): TransientErrorInfo | undefined {
  if (event !== 'StopFailure' || rateLimitFromCodexHook(event, payload, options)) return undefined;
  const text = joinFields(payload, WRAPPER_FAILURE_FIELDS);
  if (!text || BILLING_PATTERN.test(text) || isPermanentErrorText(text)) return undefined;
  if (!CODEX_TRANSIENT_PATTERN.test(text) && !isTransientErrorText(text)) return undefined;
  return { message: oneLine(text) };
}
