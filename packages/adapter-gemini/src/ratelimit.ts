/**
 * Usage-limit detection for Gemini CLI (docs/DESIGN.md §3.5). Gemini CLI writes no transcript core
 * can read, so the signals are the wrapper's failure hook first and the screen last.
 *
 * Headless (`-p`) runs print the API error, as `[API Error: <message> (Status: <status>)]` or a raw
 * Google API error body:
 *   "You have exhausted your capacity on this model. Your quota will reset after 2h31m12s."
 *     (Code Assist / Google sign-in)
 *   "You exceeded your current quota ... Quota exceeded for metric: ..., limit: 50, model: gemini-2.5-pro
 *    Please retry in 38.06s." (Gemini API key)
 * The interactive UI shows the CLI's own wording, reset time formatted as `h:mm AM GMT+3`:
 *   "Usage limit reached for gemini-2.5-pro." / "Access resets at 3:45 PM GMT+3."
 *
 * Quotas are per model (Pro, Flash, Flash-Lite), so a limit that names a model opens that model's pool.
 * `limit: 0` means the model has no quota on this tier at all: that never resets, so it is no limit.
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
  oneLine,
  parseDurationMs,
  type RateLimitInfo,
  resolveWallClock,
  type TransientErrorInfo,
  WRAPPER_FAILURE_FIELDS,
  zoneFromLabel,
} from '@emberline/adapter-sdk';

/** Gemini CLI's and the Gemini APIs' usage-limit wording. */
const LIMIT_PATTERN =
  /usage limit reached for|exhausted your capacity|quota exceeded for (?:quota )?metric|reached your daily [\w.-]+ quota limit|quota will reset/i;

/** No quota at all on this tier (`limit: 0`), or a spending cap: nothing to wait for. */
const NO_QUOTA_PATTERN = /\blimit:\s*0(?![\d.])|spending cap|monthly spend/i;

/** Model names Gemini prints, mapped to Emberline's model ids (the quota pools). */
const MODEL_POOLS: readonly [RegExp, string][] = [
  [/gemini-[\d.]+-flash-lite\b/i, 'gemini-flash-lite'],
  [/gemini-[\d.]+-flash\b/i, 'gemini-flash'],
  [/gemini-[\d.]+-pro\b/i, 'gemini-pro'],
];

export function isGeminiLimitText(text: string): boolean {
  return LIMIT_PATTERN.test(text);
}

/** The pool a limit names, or the run's own model for "on this model"; `*` when neither is known. */
function poolFor(text: string, options: LimitOptions): string {
  for (const [pattern, pool] of MODEL_POOLS) if (pattern.test(text)) return pool;
  const own = MODEL_POOLS.find(([, pool]) => pool === options.model);
  return own && /\bthis model\b/i.test(text) ? own[1] : '*';
}

/**
 * The limit sentence, starting at Gemini's own wording rather than at the JSON or `[API Error:`
 * framing around it; the shared rules pick it for other (429) text.
 */
function limitMessage(text: string): string {
  const match = LIMIT_PATTERN.exec(text);
  if (!match) return oneLine(limitSentence(text, []));
  let start = 0;
  for (const boundary of text
    .slice(0, match.index)
    .matchAll(/[.!?]\s|\n| — |API Error:\s*|\*\s*|message\s*:\s*/gi))
    start = boundary.index + boundary[0].length;
  return oneLine(limitSentence(text.slice(start), [LIMIT_PATTERN]));
}

/**
 * The reset time of a Gemini limit message: "quota will reset after 2h31m12s", "Please retry in
 * 38.06s", or "Access resets at 3:45 PM GMT+3" (the zone label may be an offset, UTC, or an
 * abbreviation; an abbreviation is read in `timeZone`, the zone the CLI formatted it in).
 */
export function parseGeminiResetTime(text: string, options: LimitOptions = {}): Date | undefined {
  const now = options.now ?? new Date();
  const after = /(?:reset after|retry in)\s+((?:\d+(?:\.\d+)?\s*(?:ms|[dhms])\s*)+)/i.exec(text);
  if (after) {
    const ms = parseDurationMs(after[1] ?? '');
    if (ms !== undefined) return new Date(now.getTime() + ms);
  }
  const at =
    /resets at\s+(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s+((?:GMT|UTC)[+-]\d{1,2}(?::\d{2})?|GMT|UTC|[A-Z]{2,5}))?/i.exec(
      text,
    );
  if (!at) return undefined;
  const [, hourText, minuteText, meridiem, zoneText] = at;
  const hour = hour24(hourText ?? '', meridiem);
  if (hour === undefined) return undefined;
  return resolveWallClock(
    { hour, minute: Number(minuteText), zone: zoneFromLabel(zoneText) },
    now,
    options.timeZone,
  );
}

/** The usage limit a wrapper `StopFailure` reports, or undefined. */
export function rateLimitFromGeminiHook(
  event: string,
  payload: HookPayloadLike,
  options: LimitOptions = {},
): RateLimitInfo | undefined {
  if (event !== 'StopFailure') return undefined;
  const text = joinFields(payload, WRAPPER_FAILURE_FIELDS);
  if (NO_QUOTA_PATTERN.test(text)) return undefined;
  if (!isGeminiLimitText(text) && !isGenericLimit(text)) return undefined;
  return {
    message: limitMessage(text),
    resetsAt: parseGeminiResetTime(text, options),
    pool: poolFor(text, options),
  };
}

/**
 * The last Gemini limit message on a terminal snapshot. Its reset sits on the next line
 * ("Access resets at ..."), so two following lines are read with it.
 */
export function rateLimitFromGeminiScreen(
  ansi: string,
  options: LimitOptions = {},
): RateLimitInfo | undefined {
  const found = lastLimitOnScreen(ansi, isGeminiLimitText, 2);
  if (!found || NO_QUOTA_PATTERN.test(found.text)) return undefined;
  return {
    message: oneLine(found.line),
    resetsAt: parseGeminiResetTime(found.text, options),
    pool: poolFor(found.text, options),
  };
}

/** Gemini's overload wording ("high demand", 503 UNAVAILABLE) besides the shared outage patterns. */
const GEMINI_TRANSIENT_PATTERN = /experiencing high demand|model is overloaded/i;

/** A Gemini turn that died on an outage or overload rather than a limit or a sign-in problem. */
export function transientErrorFromGeminiHook(
  event: string,
  payload: HookPayloadLike,
  options: LimitOptions = {},
): TransientErrorInfo | undefined {
  if (event !== 'StopFailure' || rateLimitFromGeminiHook(event, payload, options)) return undefined;
  const text = joinFields(payload, WRAPPER_FAILURE_FIELDS);
  if (!text || NO_QUOTA_PATTERN.test(text) || isPermanentErrorText(text)) return undefined;
  if (!GEMINI_TRANSIENT_PATTERN.test(text) && !isTransientErrorText(text)) return undefined;
  return { message: oneLine(text) };
}
