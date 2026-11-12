/**
 * Vendor-neutral building blocks for usage-limit and error detection (docs/DESIGN.md §3.5).
 *
 * Each adapter owns the wording of its own CLI (banners, reset clauses, quota pools); what every CLI
 * shares lives here: explicit HTTP 429 / RESOURCE_EXHAUSTED detection, billing exclusions, provider
 * outage classification, time-zone-aware reset parsing and terminal-output cleanup.
 */

/** A hook payload as adapters read it: Claude Code's JSON or the wrapper script's. */
export type HookPayloadLike = Readonly<Record<string, unknown>>;

export interface RateLimitInfo {
  /** The limit text as shown by the CLI (trimmed, single line). */
  message: string;
  /** Parsed reset time, when the text contained one. */
  resetsAt?: Date;
  /** Quota pool the limit applies to; `*` = every model of the provider. */
  pool: string;
}

export interface TransientErrorInfo {
  /** The error as reported (trimmed, single line). */
  message: string;
}

/** Inputs every limit parser takes besides the CLI's text. */
export interface LimitOptions {
  now?: Date;
  /** IANA zone for reset times printed without one (the runner's zone). */
  timeZone?: string;
  /** The run's model, when the adapter splits quota pools by model. */
  model?: string | null;
}

/**
 * An HTTP 429 named as such ("HTTP 429", "status 429", "code 429", "error 429", "(429)",
 * "429 Too Many Requests") or gRPC's RESOURCE_EXHAUSTED. A bare "429" is ordinary output
 * ("expected 429 but got 200"), never a limit.
 */
export const EXPLICIT_LIMIT_PATTERN =
  /RESOURCE_EXHAUSTED|\b(?:http|status|code|error|error_code|status_code)\b["']?\s*[:=]?\s*\(?429\b|\(429\)|\b429\s+too many requests/i;

/** Softer limit wording from any CLI or API: rate limits, exhausted quotas. Checked on failures only. */
export const GENERIC_LIMIT_PATTERN =
  /too many requests|\brate[ _-]?limit(?:ed| exceeded| reached)?|quota (?:has been |was |is )?(?:reached|exceeded|exhausted)/i;

/** Quota words that are really billing problems; never a limit that resets. */
const BILLING_PATTERN = /insufficient[_ ]quota|billing|credit balance|payment required/i;

/** Billing problems that win even over an explicit 429 (Gemini's 429 text points at "plan and billing details"). */
const HARD_BILLING_PATTERN = /insufficient[_ ]quota|credit balance|payment required/i;

/** A provider limit in any CLI's failure text: an explicit 429 counts unless it is a hard billing error. */
export function isGenericLimit(text: string): boolean {
  if (EXPLICIT_LIMIT_PATTERN.test(text)) return !HARD_BILLING_PATTERN.test(text);
  return GENERIC_LIMIT_PATTERN.test(text) && !BILLING_PATTERN.test(text);
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

/** Whether failure text reads like a temporary outage (and not like a permanent error). */
export function isTransientErrorText(text: string): boolean {
  return !PERMANENT_ERROR_PATTERN.test(text) && TRANSIENT_ERROR_PATTERN.test(text);
}

/** Whether failure text names an error a retry cannot fix. */
export function isPermanentErrorText(text: string): boolean {
  return PERMANENT_ERROR_PATTERN.test(text);
}

const asString = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * A hook text field, trimmed. The wrapper cuts its error detail with `tail -c`, which can split a
 * multi-byte character; the leftover bytes decode to U+FFFD at the start, so those are dropped.
 */
export const cleanField = (value: unknown) =>
  asString(value)
    .replace(/^[\s�]+/, '')
    .trim();

/** The distinct, non-empty text fields of a payload, joined with " — ". */
export function joinFields(payload: HookPayloadLike, keys: readonly string[]): string {
  return keys
    .map((key) => cleanField(payload[key]))
    .filter((value, index, all) => value && all.indexOf(value) === index)
    .join(' — ');
}

/** The wrapper script's failure fields (`emberline-hook StopFailure` from a non-Claude CLI). */
export const WRAPPER_FAILURE_FIELDS = [
  'last_assistant_message',
  'error_details',
  'message',
  'reason',
] as const;

/** Where the CLI's raw error detail starts: Antigravity's `AGY_ERROR:` dump or a JSON blob. */
const ERROR_DETAIL = /\s*(?:\bAGY_ERROR:|\{)/g;

/** The reset clause ("Resets in 31h43m", "resets 2pm", "limit will reset at 5pm", "try again at"). */
const RESET_CLAUSE = /\b(?:resets?|try again|retry in)\b/gi;

/** The end of a sentence (or of a joined source): a stop followed by a space, a line break, " — ". */
const SENTENCE_END = /[.!?](?=\s|$)|\n| — /g;

/** The first match of the global `pattern` at or after `from`, or undefined. */
function indexFrom(
  pattern: RegExp,
  text: string,
  from: number,
): { index: number; length: number } | undefined {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

/**
 * The sentence that states the limit: from the start of the sentence holding the earliest match of
 * `patterns` to the end of the sentence carrying the reset time, or else up to the CLI's raw error
 * detail (`AGY_ERROR: { … }`, a JSON blob), or else the end of the text. Tool output printed
 * before it is dropped. Falls back to the whole text when no pattern matches.
 */
export function limitSentence(text: string, patterns: readonly RegExp[]): string {
  let at = -1;
  for (const pattern of [...patterns, EXPLICIT_LIMIT_PATTERN, GENERIC_LIMIT_PATTERN]) {
    const index = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text)?.index;
    if (index !== undefined && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return text;
  const before = text.slice(0, at);
  let start = 0;
  // Sentence ends, and "error:" labels (the wrapper joins lines with spaces, so there may be no other boundary).
  for (const boundary of before.matchAll(/[.!?]\s|\n| — /g)) start = boundary.index + boundary[0].length;
  for (const label of before.matchAll(/\berror:\s/gi)) start = Math.max(start, label.index);
  let end = indexFrom(ERROR_DETAIL, text, at + 1)?.index ?? text.length;
  const reset = indexFrom(RESET_CLAUSE, text, at);
  if (reset && reset.index < end) {
    const stop = indexFrom(SENTENCE_END, text, reset.index + reset.length);
    // Keeps the full stop, drops a line break or the " — " join.
    if (stop && stop.index < end) end = stop.index + (/^[.!?]$/.test(text[stop.index] ?? '') ? 1 : 0);
  }
  return text.slice(start, end).trim();
}

/** Collapses whitespace and caps the length of a message shown on the board. */
export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

const ESC = 0x1b;
const BEL = 0x07;

const inRange = (code: number, low: number, high: number) => code >= low && code <= high;

/**
 * Where the escape sequence starting at `start` (an ESC) ends: after an OSC (`ESC ]` … BEL or
 * `ESC \`), a CSI (`ESC [` parameters, intermediates, final byte), or a two-byte escape. An
 * unterminated sequence drops its lead-in only, so the text after it stays readable.
 */
function escapeEnd(data: string, start: number): number {
  const next = data.charCodeAt(start + 1);
  if (next === 0x5d) {
    for (let i = start + 2; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code === BEL) return i + 1;
      if (code === ESC) return data.charCodeAt(i + 1) === 0x5c ? i + 2 : start + 2;
    }
    return start + 2;
  }
  if (next === 0x5b) {
    let i = start + 2;
    while (i < data.length && inRange(data.charCodeAt(i), 0x30, 0x3f)) i++;
    while (i < data.length && inRange(data.charCodeAt(i), 0x20, 0x2f)) i++;
    return i < data.length && inRange(data.charCodeAt(i), 0x40, 0x7e) ? i + 1 : start + 1;
  }
  return inRange(next, 0x40, 0x5a) || inRange(next, 0x5c, 0x5f) ? start + 2 : start + 1;
}

/** Strips ANSI/OSC escape sequences and control characters (tab and line feed kept) from terminal output. */
export function stripAnsi(data: string): string {
  let out = '';
  let i = 0;
  while (i < data.length) {
    const code = data.charCodeAt(i);
    if (code === ESC) {
      i = escapeEnd(data, i);
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      i++;
      continue;
    }
    out += data[i];
    i++;
  }
  return out;
}

/** The non-empty lines of a terminal snapshot, escapes and box-drawing borders removed. */
export function screenLines(ansi: string): string[] {
  return stripAnsi(ansi)
    .split('\n')
    .map((line) => line.replace(/^[\s│┃║╭╰⎿■✕✖]+|[\s│┃║╮╯]+$/g, '').trim())
    .filter(Boolean);
}

/**
 * The last screen line `isLimit` accepts, joined with the lines after it (up to `followLines`):
 * the reset time may sit on the next line, or wrap onto it on a narrow terminal.
 */
export function lastLimitOnScreen(
  ansi: string,
  isLimit: (line: string) => boolean,
  followLines = 1,
): { line: string; text: string } | undefined {
  const lines = screenLines(ansi);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!isLimit(line)) continue;
    return { line, text: lines.slice(i, i + 1 + followLines).join(' ') };
  }
  return undefined;
}

/**
 * A duration such as "2h31m12s", "38.06s", "450ms", "2 days 3 hours 15 minutes" or "4h 12m", in ms.
 * Undefined when the text holds no unit the parser knows.
 */
export function parseDurationMs(text: string): number | undefined {
  const units: [RegExp, number][] = [
    [/(\d+(?:\.\d+)?)\s*(?:d|days?)\b/i, 86_400_000],
    [/(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)(?![a-z])/i, 3_600_000],
    [/(\d+(?:\.\d+)?)\s*(?:m|mins?|minutes?)(?![a-z])/i, 60_000],
    [/(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)(?![a-z])/i, 1_000],
    [/(\d+(?:\.\d+)?)\s*ms\b/i, 1],
  ];
  let total = 0;
  let found = false;
  for (const [pattern, factor] of units) {
    const match = pattern.exec(text);
    if (!match) continue;
    found = true;
    total += Number(match[1]) * factor;
  }
  return found ? Math.round(total) : undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The 0-based month of a month name or abbreviation ("Oct", "october"), or -1. */
export function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

/** A wall-clock time as a CLI prints it, without the instant it means. */
export interface WallClockTime {
  hour: number;
  minute: number;
  /** 0-based; with `day`, the time is on that date. */
  month?: number;
  day?: number;
  year?: number;
  /** IANA zone or UTC offset ("+03:00"); falls back to the default zone. */
  zone?: string;
}

/**
 * The instant a printed wall-clock time means: today's (or tomorrow's, once it has passed) when no
 * date is given; with a date but no year, the next such date (a "Jan 2" read in late December is next year).
 */
export function resolveWallClock(time: WallClockTime, now: Date, defaultTimeZone = 'UTC'): Date | undefined {
  const { hour, minute } = time;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const zone = validZone(time.zone) ?? validZone(defaultTimeZone) ?? 'UTC';
  const today = wallDate(now, zone);
  if (time.month !== undefined && time.day !== undefined) {
    if (time.month < 0) return undefined;
    if (time.year !== undefined) return zonedToUtc(time.year, time.month, time.day, hour, minute, zone);
    let candidate = zonedToUtc(today.year, time.month, time.day, hour, minute, zone);
    if (candidate.getTime() < now.getTime() - 86_400_000) {
      candidate = zonedToUtc(today.year + 1, time.month, time.day, hour, minute, zone);
    }
    return candidate;
  }
  let candidate = zonedToUtc(today.year, today.month, today.day, hour, minute, zone);
  if (candidate.getTime() <= now.getTime() - 60_000) {
    candidate = zonedToUtc(today.year, today.month, today.day + 1, hour, minute, zone);
  }
  return candidate;
}

/** A 12-hour clock reading ("3", "pm") as a 24-hour hour, or undefined when out of range. */
export function hour24(hourText: string, meridiem: string | undefined): number | undefined {
  let hour = Number(hourText);
  if (!meridiem) return hour <= 23 ? hour : undefined;
  if (hour < 1 || hour > 12) return undefined;
  hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  return hour;
}

/**
 * A zone as CLIs print it after a time: an IANA name, "UTC"/"GMT", or an offset such as "GMT+3",
 * "UTC-04:00" or "+05:30". Abbreviations like "EDT" are ambiguous and give undefined.
 */
export function zoneFromLabel(label: string | undefined): string | undefined {
  const text = label?.trim();
  if (!text) return undefined;
  if (/^(?:utc|gmt|z)$/i.test(text)) return 'UTC';
  const offset = /^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(text);
  if (offset) {
    const [, sign, hours, minutes] = offset;
    return validZone(`${sign}${(hours ?? '0').padStart(2, '0')}:${minutes ?? '00'}`);
  }
  return text.includes('/') ? validZone(text) : undefined;
}

/**
 * Parses the reset time out of a limit message; undefined when there is none. Understands the
 * Claude-style clauses most CLIs share:
 *   "resets 2pm", "resets 3:30pm (Europe/Istanbul)", "resets Oct 14, 9am (UTC)",
 *   "limit will reset at 5pm (America/New_York)", "usage limit reached|1760356800", "resets in 2h 15m".
 * Times without a zone are read in `defaultTimeZone` (the runner's zone).
 */
export function parseResetTime(
  text: string,
  now: Date = new Date(),
  defaultTimeZone = 'UTC',
): Date | undefined {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const relative =
    /resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?(?:\s*\d+\s*s(?:ec(?:onds?)?)?)?/i.exec(
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
  const hour = hour24(hourText ?? '', meridiem);
  if (hour === undefined) return undefined;
  return resolveWallClock(
    {
      hour,
      minute: Number(minuteText ?? 0),
      ...(monthName && dayText ? { month: monthIndex(monthName), day: Number(dayText) } : {}),
      zone: zoneText?.trim(),
    },
    now,
    defaultTimeZone,
  );
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
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const guess = Date.UTC(year, month, day, hour, minute);
  let ts = guess - zoneOffset(guess, zone);
  // Re-check once across DST boundaries.
  const corrected = guess - zoneOffset(ts, zone);
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}
