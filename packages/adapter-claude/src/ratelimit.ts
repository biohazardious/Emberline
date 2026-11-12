/**
 * Usage-limit detection for Claude Code (docs/DESIGN.md §3.5), and for the wrapped CLIs that fall
 * back to Claude (Antigravity, Copilot, Aider).
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
import {
  cleanField,
  type HookPayloadLike,
  isGenericLimit,
  isPermanentErrorText,
  isTransientErrorText,
  joinFields,
  lastLimitOnScreen,
  limitSentence,
  oneLine,
  parseResetTime,
  type RateLimitInfo,
  type TransientErrorInfo,
  WRAPPER_FAILURE_FIELDS,
} from '@emberline/adapter-sdk';

export {
  parseResetTime,
  type RateLimitInfo,
  stripAnsi,
  type TransientErrorInfo,
} from '@emberline/adapter-sdk';

/** Which run hit the limit: decides the patterns and the pool. */
export interface LimitContext {
  agent?: string;
  model?: string | null;
}

/** Matches the limit banners of the pinned CLI (and the older "usage limit reached|<epoch>" form). */
const LIMIT_PATTERN =
  /(usage limit reached|(?:5-hour|weekly|opus|sonnet|session|daily)\s+limit reached|you'?ve (?:hit|reached) your (?:usage )?limit|rate limit reached|limit will reset|you'?ve hit your (?:monthly|individual|organization'?s?|team'?s?) spend limit)/i;

/** Claude limits tied to one model family ("Opus weekly limit reached"). */
const CLAUDE_MODEL_POOL = /\b(opus|sonnet|haiku|fable)\b[^.\n]{0,20}\blimit\b/i;

function poolFor(ctx: LimitContext | undefined, text: string): string {
  if ((ctx?.agent ?? 'claude') === 'claude') {
    const match = CLAUDE_MODEL_POOL.exec(text);
    return match ? (match[1] ?? '').toLowerCase() : '*';
  }
  return '*';
}

const MAX_BANNER_LENGTH = 200;

export function isLimitText(text: string): boolean {
  return LIMIT_PATTERN.test(text);
}

/**
 * Rate limit carried by a hook, if any. `StopFailure` with `error: rate_limit` always counts;
 * `Stop`/`StopFailure` whose message reads like a limit banner count too, and a `StopFailure`
 * from any CLI whose text reads like a 429 / exhausted quota (billing problems excepted).
 */
export function rateLimitFromHook(
  event: string,
  payload: HookPayloadLike,
  now: Date = new Date(),
  defaultTimeZone = 'UTC',
  ctx?: LimitContext,
): RateLimitInfo | undefined {
  if (event !== 'StopFailure' && event !== 'Stop') return undefined;
  const message = cleanField(payload.last_assistant_message);
  const details = cleanField(payload.error_details);
  const wrapper = [cleanField(payload.message), cleanField(payload.reason)].find(Boolean) ?? '';
  const isRateLimit = event === 'StopFailure' && payload.error === 'rate_limit';
  // On `Stop` the message is Claude's own answer; only a short banner-like text counts.
  const bannerOnly = event === 'StopFailure' || message.length <= MAX_BANNER_LENGTH;
  const text = [message, details, wrapper].filter((v, i, all) => v && all.indexOf(v) === i).join(' — ');
  const claudeBanner = bannerOnly && isLimitText(message);
  const generic = event === 'StopFailure' && isGenericLimit(text);
  if (!isRateLimit && !claudeBanner && !generic) return undefined;
  return {
    message: oneLine(limitSentence(text, [LIMIT_PATTERN]) || 'rate limit reached'),
    resetsAt: parseResetTime(text, now, defaultTimeZone),
    pool: poolFor(ctx, text),
  };
}

/** Claude Code >= 2.1.234 reports its own usage-limit wait ending without continuing. */
export function isQuotaWaitNotification(payload: HookPayloadLike): boolean {
  const kind = [payload.notification_type, payload.type, payload.matcher, payload.message]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(' ');
  return /quota_auto_resume_disabled|usage limit reached/i.test(kind);
}

/** Claude Code's `StopFailure` error kinds. */
const TRANSIENT_ERROR_KINDS = new Set(['server_error', 'overloaded', 'api_error', 'network_error']);
const PERMANENT_ERROR_KINDS = new Set([
  'authentication_failed',
  'billing_error',
  'invalid_request',
  'max_output_tokens',
]);

/**
 * A turn that died on a temporary provider or network error (a `StopFailure` that is not a usage
 * limit), so trying the same turn again later is worthwhile. Sign-in, billing, quota and request
 * errors never count.
 */
export function transientErrorFromHook(
  event: string,
  payload: HookPayloadLike,
  ctx?: LimitContext,
): TransientErrorInfo | undefined {
  if (event !== 'StopFailure' || rateLimitFromHook(event, payload, new Date(), 'UTC', ctx)) return undefined;
  const kind = typeof payload.error === 'string' ? payload.error : '';
  const text = joinFields(payload, WRAPPER_FAILURE_FIELDS);
  if (PERMANENT_ERROR_KINDS.has(kind) || isPermanentErrorText(text)) return undefined;
  if (!TRANSIENT_ERROR_KINDS.has(kind) && !isTransientErrorText(text)) return undefined;
  return { message: oneLine(text || kind) };
}

/** Last limit banner visible in a terminal snapshot (serialized ANSI), with its reset time. */
export function rateLimitFromScreen(
  ansi: string,
  now: Date = new Date(),
  defaultTimeZone = 'UTC',
  ctx?: LimitContext,
): RateLimitInfo | undefined {
  const found = lastLimitOnScreen(ansi, isLimitText);
  if (!found) return undefined;
  return {
    message: oneLine(found.line.replace(/^[⎿│\s�]+/, '')),
    resetsAt: parseResetTime(found.text, now, defaultTimeZone),
    pool: poolFor(ctx, found.text),
  };
}
