import { describe, expect, it } from 'vitest';
import { nextStateFromHook, stateAfterExit } from './index.js';
import {
  isLimitText,
  parseResetTime,
  rateLimitFromHook,
  rateLimitFromScreen,
  stripAnsi,
  transientErrorFromHook,
} from './ratelimit.js';

// 2026-10-13 09:30 UTC (12:30 in Istanbul, UTC+3; 05:30 in New York, UTC-4).
const NOW = new Date('2026-10-13T09:30:00Z');

describe('parseResetTime', () => {
  const cases: [string, string, string | undefined][] = [
    ['5-hour limit reached ∙ resets 2pm', 'UTC', '2026-10-13T14:00:00.000Z'],
    ['5-hour limit reached ∙ resets 2:30pm', 'UTC', '2026-10-13T14:30:00.000Z'],
    // Already past today -> tomorrow.
    ['5-hour limit reached ∙ resets 8am', 'UTC', '2026-10-14T08:00:00.000Z'],
    ["You've hit your limit · resets 3pm (Europe/Istanbul)", 'UTC', '2026-10-13T12:00:00.000Z'],
    // Zone missing from the text: read in the runner's zone.
    ['5-hour limit reached ∙ resets 3pm', 'Europe/Istanbul', '2026-10-13T12:00:00.000Z'],
    [
      'Claude usage limit reached. Your limit will reset at 5pm (America/New_York).',
      'UTC',
      '2026-10-13T21:00:00.000Z',
    ],
    ['Weekly limit reached ∙ resets Oct 14, 9am (UTC)', 'UTC', '2026-10-14T09:00:00.000Z'],
    ['Weekly limit reached ∙ resets Jan 2 at 9am (UTC)', 'UTC', '2027-01-02T09:00:00.000Z'],
    ['resets 12am', 'UTC', '2026-10-14T00:00:00.000Z'],
    ['resets 12pm', 'UTC', '2026-10-13T12:00:00.000Z'],
    ['limit reached, resets 14:15 (Europe/Istanbul)', 'UTC', '2026-10-13T11:15:00.000Z'],
    ['Claude AI usage limit reached|1760356800', 'UTC', '2025-10-13T12:00:00.000Z'],
    ['usage limit reached, resets in 2h 15m', 'UTC', '2026-10-13T11:45:00.000Z'],
    ['usage limit reached, resets in 45 minutes', 'UTC', '2026-10-13T10:15:00.000Z'],
    // Unknown zone falls back to the default.
    ['resets 3pm (Mars/Olympus)', 'UTC', '2026-10-13T15:00:00.000Z'],
    ['API Error: Rate limit reached', 'UTC', undefined],
    ['Resets in 31h43m5s.', 'UTC', new Date(NOW.getTime() + 1903 * 60_000).toISOString()],
    ['resets 3', 'UTC', undefined],
    ['resets 13pm', 'UTC', undefined],
  ];
  it.each(cases)('%s (%s)', (text, zone, expected) => {
    expect(parseResetTime(text, NOW, zone)?.toISOString()).toBe(expected);
  });

  it('handles DST transitions', () => {
    // US DST ends 2026-11-01; at 2026-10-31 20:00 UTC New York is UTC-4, the next day UTC-5.
    const now = new Date('2026-10-31T20:00:00Z');
    expect(parseResetTime('resets 9am (America/New_York)', now)?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });
});

describe('rateLimitFromHook', () => {
  it('reads StopFailure rate_limit with the reset time', () => {
    const info = rateLimitFromHook(
      'StopFailure',
      { error: 'rate_limit', error_details: '429', last_assistant_message: "You've hit your limit · resets 2pm (UTC)" },
      NOW,
    );
    expect(info).toEqual({
      message: "You've hit your limit · resets 2pm (UTC) — 429",
      resetsAt: new Date('2026-10-13T14:00:00Z'),
      pool: '*',
    });
  });

  it('reads StopFailure rate_limit without a reset time', () => {
    const info = rateLimitFromHook('StopFailure', { error: 'rate_limit' }, NOW);
    expect(info).toEqual({ message: 'rate limit reached', resetsAt: undefined, pool: '*' });
  });

  it('ignores other API errors and normal answers', () => {
    expect(rateLimitFromHook('StopFailure', { error: 'overloaded', last_assistant_message: 'Overloaded' })).toBe(
      undefined,
    );
    expect(rateLimitFromHook('Stop', { last_assistant_message: 'Done, tests pass.' })).toBe(undefined);
    const essay = `I added a rate limiter. When the usage limit reached state occurs we back off. ${'x'.repeat(300)}`;
    expect(rateLimitFromHook('Stop', { last_assistant_message: essay })).toBe(undefined);
    expect(rateLimitFromHook('Notification', { message: 'usage limit reached' })).toBe(undefined);
  });

  it('accepts a banner delivered through Stop', () => {
    const info = rateLimitFromHook('Stop', { last_assistant_message: 'Claude AI usage limit reached|1760356800' }, NOW);
    expect(info?.resetsAt?.toISOString()).toBe('2025-10-13T12:00:00.000Z');
  });
});

describe('rateLimitFromScreen', () => {
  it('finds the last banner in a serialized snapshot', () => {
    const screen = [
      '\x1b[2J\x1b[H\x1b[38;5;246m> fix the tests\x1b[0m\r\n',
      '\x1b[1m⏺\x1b[0m Running tests…\r\n',
      '  \x1b[31m⎿  5-hour limit reached ∙ resets 4pm\x1b[0m\r\n',
      '\x1b]0;claude\x07\r\n',
      '╭──────────╮\r\n│ >        │\r\n╰──────────╯\r\n',
    ].join('');
    expect(rateLimitFromScreen(screen, NOW, 'UTC')).toEqual({
      message: '5-hour limit reached ∙ resets 4pm',
      resetsAt: new Date('2026-10-13T16:00:00Z'),
      pool: '*',
    });
  });

  it('returns undefined when no banner is visible', () => {
    expect(rateLimitFromScreen('\x1b[1mhello\x1b[0m\r\nall good', NOW)).toBe(undefined);
  });

  it('strips escape sequences', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')).toBe('red link');
  });
});

describe('limit-aware state machine', () => {
  it('moves to rate_limited on StopFailure rate_limit and waits through idle reminders', () => {
    expect(nextStateFromHook('working', 'StopFailure', { error: 'rate_limit' })).toBe('rate_limited');
    expect(nextStateFromHook('rate_limited', 'Notification', { notification_type: 'idle_prompt' })).toBe(undefined);
    expect(nextStateFromHook('rate_limited', 'SessionEnd')).toBe(undefined);
    expect(nextStateFromHook('rate_limited', 'UserPromptSubmit')).toBe('working');
  });

  it('other API errors need the user', () => {
    expect(nextStateFromHook('working', 'StopFailure', { error: 'overloaded' })).toBe('waiting_input');
  });

  it('keeps rate_limited after the process exits', () => {
    expect(stateAfterExit('rate_limited', 0)).toBe('rate_limited');
  });

  it('recognises the banners', () => {
    for (const text of [
      '5-hour limit reached ∙ resets 2pm',
      'Weekly limit reached',
      "You've hit your limit · resets 3pm",
      'Claude usage limit reached.',
    ]) {
      expect(isLimitText(text), text).toBe(true);
    }
  });
});

describe('transientErrorFromHook', () => {
  const agy503 =
    'Session e9ad1581 connected error: failed to send message: send failed; already reported to the user: Eligibility check failed: failed to get load code assist response: UNAVAILABLE (code 503): The service is currently unavailable. Turn ERROR';

  it('retries provider outages and network errors', () => {
    for (const payload of [
      { error: 'cli_exit', reason: agy503, message: agy503 },
      { error: 'server_error', last_assistant_message: 'API Error: 500 Internal server error' },
      { error: 'unknown', last_assistant_message: 'API Error: 529 {"type":"overloaded_error"}' },
      { error: 'cli_exit', message: 'request to https://api.openai.com failed, reason: socket hang up' },
      { error: 'cli_exit', message: 'getaddrinfo EAI_AGAIN generativelanguage.googleapis.com' },
      { error: 'server_error' },
    ]) {
      expect(transientErrorFromHook('StopFailure', payload), JSON.stringify(payload)).toBeDefined();
    }
    expect(transientErrorFromHook('StopFailure', { error: 'cli_exit', message: agy503 })?.message).toContain('UNAVAILABLE (code 503)');
  });

  it('never retries sign-in, billing, quota, request errors or usage limits', () => {
    for (const payload of [
      { error: 'authentication_failed', last_assistant_message: 'API Error: 503 upstream' },
      { error: 'cli_exit', message: 'Error: 401 Unauthorized — please log in' },
      { error: 'billing_error', last_assistant_message: 'Credit balance is too low' },
      { error: 'cli_exit', message: 'insufficient_quota: You exceeded your current quota' },
      { error: 'invalid_request', last_assistant_message: 'prompt is too long' },
      { error: 'rate_limit', last_assistant_message: '5-hour limit reached ∙ resets 2pm' },
      { error: 'cli_exit', message: 'codex exited with code 2' },
    ]) {
      expect(transientErrorFromHook('StopFailure', payload), JSON.stringify(payload)).toBeUndefined();
    }
    expect(transientErrorFromHook('Stop', { last_assistant_message: 'The 503 page now renders' })).toBeUndefined();
  });
});

const AGY_QUOTA =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 31h43m5s. ' +
  'AGY_ERROR: { short_error : RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 31h43m5s. , status : RESOURCE_EXHAUSTED , error_code :429, retryable :true}';

describe('provider limits', () => {
  it('reads the Antigravity quota message from the wrapper StopFailure (2026-10-16 TrueNAS)', () => {
    const info = rateLimitFromHook(
      'StopFailure',
      { error: 'cli_exit', reason: AGY_QUOTA, message: AGY_QUOTA },
      NOW,
      'UTC',
      { agent: 'antigravity', model: 'argon' },
    );
    expect(info?.pool).toBe('*');
    expect(info?.resetsAt?.toISOString()).toBe(new Date(NOW.getTime() + (31 * 60 + 43) * 60_000).toISOString());
    expect(info?.message).toContain('Individual quota reached');
  });

  it('turns that hook into rate_limited, not waiting_input, and not a transient retry', () => {
    const payload = { error: 'cli_exit', message: AGY_QUOTA };
    expect(nextStateFromHook('working', 'StopFailure', payload, { agent: 'antigravity' })).toBe('rate_limited');
    expect(transientErrorFromHook('StopFailure', payload, { agent: 'antigravity' })).toBeUndefined();
  });

  it('treats generic 429 / rate limit / quota reached as limits for any CLI on StopFailure only', () => {
    for (const message of ['Error: 429 Too Many Requests', 'rate limit exceeded, slow down', 'Quota exceeded for metric generate_content']) {
      expect(rateLimitFromHook('StopFailure', { error: 'cli_exit', message }, NOW, 'UTC', { agent: 'gemini' })?.pool).toBe('*');
    }
    // A short Stop answer that mentions 429 is Claude's own text, not a limit.
    expect(rateLimitFromHook('Stop', { last_assistant_message: 'Added a 429 handler.' }, NOW, 'UTC', { agent: 'claude' })).toBeUndefined();
  });

  it('does not read ordinary output as a limit (rate limit needs a word start, 429 needs an error context)', () => {
    for (const message of ['Failed to accelerate limit switches', 'AssertionError: expected 429 but got 200', 'tests: 429 passed']) {
      expect(rateLimitFromHook('StopFailure', { error: 'cli_exit', message }, NOW, 'UTC', { agent: 'gemini' }), message).toBeUndefined();
    }
    for (const message of [
      '429 Too Many Requests',
      'HTTP 429',
      'request failed with status 429',
      'API error (429): slow down',
      'Error code 429',
      'error 429 from upstream',
      'rate_limit_error: Number of requests has exceeded your rate limit',
    ]) {
      expect(rateLimitFromHook('StopFailure', { error: 'cli_exit', message }, NOW, 'UTC', { agent: 'codex' }), message).toBeDefined();
    }
    expect(rateLimitFromHook('StopFailure', { error: 'cli_exit', message: AGY_QUOTA }, NOW, 'UTC', { agent: 'antigravity' })).toBeDefined();
  });

  it('keeps an explicit 429 / RESOURCE_EXHAUSTED a limit when it only points at billing details', () => {
    const gemini =
      '[API Error: got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}]';
    expect(rateLimitFromHook('StopFailure', { error: 'cli_exit', message: gemini }, NOW, 'UTC', { agent: 'gemini' })?.pool).toBe('*');
    for (const message of [
      'RESOURCE_EXHAUSTED (code 429): insufficient_quota',
      'HTTP 429: Your credit balance is too low',
      'status 429 payment required',
    ]) {
      expect(rateLimitFromHook('StopFailure', { error: 'cli_exit', message }, NOW, 'UTC', { agent: 'gemini' }), message).toBeUndefined();
    }
  });

  it('keeps billing errors permanent', () => {
    const payload = { error: 'cli_exit', message: 'insufficient_quota: You exceeded your current quota, please check your plan and billing details' };
    expect(rateLimitFromHook('StopFailure', payload, NOW, 'UTC', { agent: 'codex' })).toBeUndefined();
    expect(transientErrorFromHook('StopFailure', payload, { agent: 'codex' })).toBeUndefined();
  });

  it('gives Claude model-specific limits their own pool', () => {
    expect(
      rateLimitFromHook('StopFailure', { error: 'rate_limit', last_assistant_message: 'Opus weekly limit reached ∙ resets Oct 20, 9am (UTC)' }, NOW, 'UTC', { agent: 'claude', model: 'opus' })?.pool,
    ).toBe('opus');
    expect(
      rateLimitFromHook('StopFailure', { error: 'rate_limit', last_assistant_message: '5-hour limit reached ∙ resets 2pm (UTC)' }, NOW, 'UTC', { agent: 'claude', model: 'opus' })?.pool,
    ).toBe('*');
  });

  it('treats Claude spend-limit messages as a limit on the whole Claude lane', () => {
    for (const message of [
      "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message",
      "You've hit your individual spend limit · ask your admin for a higher limit",
    ]) {
      const info = rateLimitFromHook('StopFailure', { error: 'rate_limit', last_assistant_message: message }, NOW, 'UTC', { agent: 'claude', model: 'opus' });
      expect(info).toMatchObject({ pool: '*', resetsAt: undefined });
    }
  });

  it('recognises a spend-limit banner without error: rate_limit, on Stop (short banner only) and on the screen', () => {
    const ctx = { agent: 'claude', model: 'opus' } as const;
    const banner = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage";
    for (const event of ['Stop', 'StopFailure'] as const) {
      expect(rateLimitFromHook(event, { last_assistant_message: banner }, NOW, 'UTC', ctx)).toMatchObject({
        pool: '*',
        resetsAt: undefined,
      });
    }
    // A long Stop message is Claude's own answer, not a banner.
    const long = `${banner} ${'and here is a long explanation of the billing page. '.repeat(6)}`;
    expect(long.length).toBeGreaterThan(200);
    expect(rateLimitFromHook('Stop', { last_assistant_message: long }, NOW, 'UTC', ctx)).toBeUndefined();
    expect(rateLimitFromScreen(`working...\n  ${banner}\n`, NOW, 'UTC', ctx)).toMatchObject({ pool: '*' });
  });

  it("reads Claude Code's usage-limit wait screen as a limit with its reset", () => {
    const screen = 'some output\n  Usage limit reached · limit resets 3:45pm (UTC)\n  Continuing automatically at 3:45pm · esc to cancel\n';
    expect(rateLimitFromScreen(screen, NOW, 'UTC', { agent: 'claude' })).toMatchObject({ pool: '*' });
    expect(rateLimitFromScreen(screen, NOW, 'UTC', { agent: 'claude' })?.resetsAt?.toISOString()).toBe('2026-10-13T15:45:00.000Z');
  });

  it("treats Claude Code's disabled auto-resume notification as a limit", () => {
    expect(nextStateFromHook('working', 'Notification', { notification_type: 'quota_auto_resume_disabled' })).toBe('rate_limited');
  });
});

describe('limit message and wrapper tail', () => {
  it('keeps the limit sentence, not the unrelated tool output before it', () => {
    const noise = 'npm WARN deprecated foo@1.0.0 Running tests: 12 passed ';
    const info = rateLimitFromHook('StopFailure', { error: 'cli_exit', message: noise + AGY_QUOTA }, NOW, 'UTC', { agent: 'antigravity' });
    expect(info?.message).toMatch(/^(error: )?Individual quota reached/);
    expect(info?.message).not.toContain('npm WARN');
    expect(info?.message).toContain('Resets in 31h43m5s');
  });

  it('drops a partial multi-byte character left by the wrapper tail', () => {
    const info = rateLimitFromHook('StopFailure', { error: 'cli_exit', message: `\uFFFD\uFFFD${AGY_QUOTA}` }, NOW, 'UTC', { agent: 'antigravity' });
    expect(info?.message.startsWith('error: Individual quota reached')).toBe(true);
    const transient = transientErrorFromHook('StopFailure', { error: 'cli_exit', message: '\uFFFDservice unavailable (code 503)' });
    expect(transient?.message).toBe('service unavailable (code 503)');
  });

  it('a quota-wait notification never revives a finished run', () => {
    const payload = { notification_type: 'quota_auto_resume_disabled' };
    expect(nextStateFromHook('done', 'Notification', payload)).toBeUndefined();
    expect(nextStateFromHook('failed', 'Notification', payload)).toBeUndefined();
    expect(nextStateFromHook('working', 'Notification', payload)).toBe('rate_limited');
  });
});
