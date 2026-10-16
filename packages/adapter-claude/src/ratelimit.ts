/**
 * Usage-limit detection for Claude Code (PROJECT.md §5.5).
 *
 * Primary signal is the `StopFailure` hook (`error: "rate_limit"`); its `last_assistant_message`
 * carries the text the CLI shows. Older/other paths surface the same text in a `Stop` hook or
 * only on screen, so the text matchers work on any of those sources.
 *
 * Reset times are parsed from strings such as:
 *   "5-hour limit reached ∙ resets 2pm"
 *   "You've hit your limit · resets 3:30pm (Europe/Istanbul)"
 *   "Weekly limit reached ∙ resets Oct 14, 9am (UTC)"
 *   "Claude usage limit reached. Your limit will reset at 5pm (America/New_York)."
 *   "Claude AI usage limit reached|1760356800"
 *   "... resets in 2h 15m"
 * Times without a zone are read in `defaultTimeZone` (the runner's zone).
 */
import type { HookEventName, HookPayload } from '@emberline/protocol';

export interface RateLimitInfo {
  /** The limit text as shown by the CLI (trimmed, single line). */
  message: string;
  /** Parsed reset time, when the text contained one. */
  resetsAt?: Date;
  /** Quota pool the limit applies to; `*` = every model of the provider. */
  pool: string;
}

/** Which run hit the limit: decides the patterns and the pool. */
export interface LimitContext {
  agent?: string;
  model?: string | null;
}

/** Matches the limit banners of the pinned CLI (and the older "usage limit reached|<epoch>" form). */
const LIMIT_PATTERN =
  /(usage limit reached|(?:5-hour|weekly|opus|sonnet|session|daily)\s+limit reached|you'?ve (?:hit|reached) your (?:usage )?limit|rate limit reached|limit will reset|you'?ve hit your (?:monthly|individual|organization'?s?|team'?s?) spend limit)/i;

/** Usage limits reported by any CLI or API: HTTP 429, rate limits, exhausted quotas. Checked on StopFailure only. */
const GENERIC_LIMIT_PATTERN =
  /\b429\b|RESOURCE_EXHAUSTED|too many requests|rate[ _-]?limit(?:ed| exceeded| reached)?|quota (?:has been |was |is )?(?:reached|exceeded|exhausted)|individual quota reached/i;

/** Quota words that are really billing problems; never a limit that resets. */
const BILLING_PATTERN = /insufficient[_ ]quota|billing|credit balance|payment required/i;

/** Claude limits tied to one model family ("Opus weekly limit reached"). */
const CLAUDE_MODEL_POOL = /\b(opus|sonnet|haiku|fable)\b[^.\n]{0,20}\blimit\b/i;

function poolFor(ctx: LimitContext | undefined, text: string): string {
  if ((ctx?.agent ?? 'claude') === 'claude') {
    const match = CLAUDE_MODEL_POOL.exec(text);
    return match ? (match[1] ?? '').toLowerCase() : '*';
  }
  return '*';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const MAX_BANNER_LENGTH = 200;

const asString = (value: unknown) => (typeof value === 'string' ? value : '');

export function isLimitText(text: string): boolean {
  return LIMIT_PATTERN.test(text);
}

/**
 * Rate limit carried by a hook, if any. `StopFailure` with `error: rate_limit` always counts;
 * `Stop`/`StopFailure` whose message reads like a limit banner count too, and a `StopFailure`
 * from any CLI whose text reads like a 429 / exhausted quota (billing problems excepted).
 */
export function rateLimitFromHook(
  event: HookEventName,
  payload: HookPayload,
  now: Date = new Date(),
  defaultTimeZone = 'UTC',
  ctx?: LimitContext,
): RateLimitInfo | undefined {
  if (event !== 'StopFailure' && event !== 'Stop') return undefined;
  const message = asString(payload.last_assistant_message).trim();
  const details = asString(payload.error_details).trim();
  const wrapper = [asString(payload.message).trim(), asString(payload.reason).trim()].find(Boolean) ?? '';
  const isRateLimit = event === 'StopFailure' && payload.error === 'rate_limit';
  // On `Stop` the message is Claude's own answer; only a short banner-like text counts.
  const bannerOnly = event === 'StopFailure' || message.length <= MAX_BANNER_LENGTH;
  const text = [message, details, wrapper].filter((v, i, all) => v && all.indexOf(v) === i).join(' — ');
  const claudeBanner = bannerOnly && isLimitText(message);
  const generic = event === 'StopFailure' && GENERIC_LIMIT_PATTERN.test(text) && !BILLING_PATTERN.test(text);
  if (!isRateLimit && !claudeBanner && !generic) return undefined;
  return {
    message: oneLine(text || 'rate limit reached'),
    resetsAt: parseResetTime(text, now, defaultTimeZone),
    pool: poolFor(ctx, text),
  };
}

/** Claude Code >= 2.1.234 reports its own usage-limit wait ending without continuing. */
export function isQuotaWaitNotification(payload: HookPayload): boolean {
  const kind = [payload.notification_type, payload.type, payload.matcher, payload.message]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(' ');
  return /quota_auto_resume_disabled|usage limit reached/i.test(kind);
}

/**
 * Errors that say nothing about the request: the provider was down, overloaded or unreachable.
 * Retrying the same turn later usually works. Checked after {@link PERMANENT_ERROR_PATTERN}.
 */
const TRANSIENT_ERROR_PATTERN =
  /\b(?:50[0234]|529)\b|service (?:is )?(?:currently |temporarily )?unavailable|\bUNAVAILABLE\b|overloaded|internal server error|bad gateway|gateway time-?out|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|socket hang up|fetch failed|network error|connection (?:reset|refused|error|closed)|try again later/i;

/** Errors a retry cannot fix: sign-in, billing, quota and malformed requests. */
const PERMANENT_ERROR_PATTERN =
  /unauthori[sz]ed|unauthenticated|authentication|not signed in|not logged in|log ?in required|invalid (?:api )?key|api key (?:is )?invalid|permission denied|forbidden|\b40[0134]\b|billing|credit balance|payment required|insufficient[_ ]quota|invalid[_ ]request|context (?:length|window)|prompt is too long|max_output_tokens/i;

/** Claude Code's `StopFailure` error kinds. */
const TRANSIENT_ERROR_KINDS = new Set(['server_error', 'overloaded', 'api_error', 'network_error']);
const PERMANENT_ERROR_KINDS = new Set(['authentication_failed', 'billing_error', 'invalid_request', 'max_output_tokens']);

export interface TransientErrorInfo {
  /** The error as reported (trimmed, single line). */
  message: string;
}

/**
 * A turn that died on a temporary provider or network error (a `StopFailure` that is not a usage
 * limit), so trying the same turn again later is worthwhile. Sign-in, billing, quota and request
 * errors never count.
 */
export function transientErrorFromHook(
  event: HookEventName,
  payload: HookPayload,
  ctx?: LimitContext,
): TransientErrorInfo | undefined {
  if (event !== 'StopFailure' || rateLimitFromHook(event, payload, new Date(), 'UTC', ctx)) return undefined;
  const kind = asString(payload.error);
  const text = [payload.last_assistant_message, payload.error_details, payload.message, payload.reason]
    .map((value) => asString(value).trim())
    .filter((value, index, all) => value && all.indexOf(value) === index)
    .join(' — ');
  if (PERMANENT_ERROR_KINDS.has(kind) || PERMANENT_ERROR_PATTERN.test(text)) return undefined;
  if (!TRANSIENT_ERROR_KINDS.has(kind) && !TRANSIENT_ERROR_PATTERN.test(text)) return undefined;
  return { message: oneLine(text || kind) };
}

/** Strips ANSI/OSC escape sequences and control characters from terminal output. */
export function stripAnsi(data: string): string {
  return (
    data
      // OSC ... BEL/ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // other two-byte escapes
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

/** Last limit banner visible in a terminal snapshot (serialized ANSI), with its reset time. */
export function rateLimitFromScreen(
  ansi: string,
  now: Date = new Date(),
  defaultTimeZone = 'UTC',
  ctx?: LimitContext,
): RateLimitInfo | undefined {
  const lines = stripAnsi(ansi)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!isLimitText(line)) continue;
    // The reset time may wrap onto the next line on narrow terminals.
    const text = `${line} ${lines[i + 1] ?? ''}`;
    return {
      message: oneLine(line.replace(/^[⎿│\s]+/, '')),
      resetsAt: parseResetTime(text, now, defaultTimeZone),
      pool: poolFor(ctx, text),
    };
  }
  return undefined;
}

/** Parses the reset time out of a limit message; undefined when there is none. */
export function parseResetTime(text: string, now: Date = new Date(), defaultTimeZone = 'UTC'): Date | undefined {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const relative = /resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?(?:\s*\d+\s*s(?:ec(?:onds?)?)?)?/i.exec(
    text,
  );
  if (relative && (relative[1] || relative[2])) {
    const minutes = Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0);
    return new Date(now.getTime() + minutes * 60_000);
  }

  const absolute =
    /resets?\s+(?:at\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(
      text,
    );
  if (!absolute) return undefined;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = absolute;
  // A bare number ("resets 3") is too ambiguous; require am/pm or minutes.
  if (!meridiem && minuteText === undefined) return undefined;

  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;

  const zone = validZone(zoneText?.trim()) ?? validZone(defaultTimeZone) ?? 'UTC';
  const today = wallDate(now, zone);

  if (monthName && dayText) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    let candidate = zonedToUtc(today.year, month, Number(dayText), hour, minute, zone);
    // "Jan 2" seen in late December means next year.
    if (candidate.getTime() < now.getTime() - 86_400_000) {
      candidate = zonedToUtc(today.year + 1, month, Number(dayText), hour, minute, zone);
    }
    return candidate;
  }

  let candidate = zonedToUtc(today.year, today.month, today.day, hour, minute, zone);
  if (candidate.getTime() <= now.getTime() - 60_000) {
    candidate = zonedToUtc(today.year, today.month, today.day + 1, hour, minute, zone);
  }
  return candidate;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function zoneParts(ts: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ts);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month') - 1,
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Calendar date of `now` in `zone` (month is 0-based). */
function wallDate(now: Date, zone: string) {
  const { year, month, day } = zoneParts(now.getTime(), zone);
  return { year, month, day };
}

/** Offset of `zone` from UTC at instant `ts`, in ms. */
function zoneOffset(ts: number, zone: string): number {
  const p = zoneParts(ts, zone);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** The instant at which the wall clock in `zone` shows the given time. Day overflow is allowed. */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const guess = Date.UTC(year, month, day, hour, minute);
  let ts = guess - zoneOffset(guess, zone);
  // Re-check once across DST boundaries.
  const corrected = guess - zoneOffset(ts, zone);
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}
