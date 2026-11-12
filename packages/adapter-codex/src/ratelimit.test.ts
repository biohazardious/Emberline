/**
 * Fixtures: message templates of Codex CLI 0.167.2 (`UsageLimitReachedError`, the retry loop, the
 * TUI error cell and rollout `token_count` records, taken from the linux-x64 binary), shaped the
 * way they reach core: the wrapper's `StopFailure` payload, a ptyd screen snapshot, a rollout line.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from './index.js';
import {
  parseCodexResetTime,
  rateLimitFromCodexHook,
  rateLimitFromCodexScreen,
  rateLimitFromCodexTranscript,
  transientErrorFromCodexHook,
} from './ratelimit.js';

// 2026-10-13 09:30 UTC (12:30 in Istanbul, UTC+3).
const NOW = new Date('2026-10-13T09:30:00Z');
const UTC = { now: NOW, timeZone: 'UTC' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const hookFixture = (name: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(fixture(name));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${name} is not a payload`);
  return { ...parsed };
};

describe('Codex limits from the failure hook (first signal)', () => {
  it('reads the Plus banner with a same-day reset in the runner zone', () => {
    const payload = hookFixture('hook-usage-limit-plus.json');
    expect(rateLimitFromCodexHook('StopFailure', payload, UTC)).toEqual({
      message:
        "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:42 PM.",
      resetsAt: new Date('2026-10-13T15:42:00Z'),
      pool: '*',
    });
    // Codex prints local time: the same text in Istanbul is three hours earlier in UTC.
    expect(
      rateLimitFromCodexHook('StopFailure', payload, { now: NOW, timeZone: 'Europe/Istanbul' })?.resetsAt,
    ).toEqual(new Date('2026-10-13T12:42:00Z'));
  });

  it('reads the dated reset ("Oct 15th, 2026 9:05 AM") of a later day', () => {
    const info = rateLimitFromCodexHook('StopFailure', hookFixture('hook-usage-limit-pro-dated.json'), UTC);
    expect(info?.resetsAt).toEqual(new Date('2026-10-15T09:05:00Z'));
    expect(info?.message.startsWith("You've hit your usage limit. Visit")).toBe(true);
  });

  it('counts the retry loop giving up on 429 as a limit without a reset', () => {
    const info = rateLimitFromCodexHook('StopFailure', hookFixture('hook-retry-429.json'), UTC);
    expect(info).toMatchObject({ pool: '*', resetsAt: undefined });
    expect(info?.message).toContain('exceeded retry limit, last status: 429 Too Many Requests');
  });

  it('keeps billing errors out: no limit, no retry', () => {
    const payload = hookFixture('hook-billing.json');
    expect(rateLimitFromCodexHook('StopFailure', payload, UTC)).toBeUndefined();
    expect(transientErrorFromCodexHook('StopFailure', payload, UTC)).toBeUndefined();
    expect(codexAdapter.nextState('working', 'StopFailure', payload, UTC)).toBe('waiting_input');
  });

  it('turns a limit hook into rate_limited, not a transient retry', () => {
    const payload = hookFixture('hook-usage-limit-plus.json');
    expect(codexAdapter.nextState('working', 'StopFailure', payload, UTC)).toBe('rate_limited');
    expect(transientErrorFromCodexHook('StopFailure', payload, UTC)).toBeUndefined();
  });

  it('ignores a clean exit', () => {
    expect(rateLimitFromCodexHook('Stop', {}, UTC)).toBeUndefined();
    expect(codexAdapter.nextState('working', 'Stop', {}, UTC)).toBe('done');
  });
});

describe('Codex limits from the rollout transcript (second signal)', () => {
  it('reads a full 5-hour window and its epoch reset', () => {
    expect(rateLimitFromCodexTranscript(fixture('rollout-rate-limits.jsonl'), UTC)).toEqual({
      message: 'Codex 5-hour limit reached',
      resetsAt: new Date('2026-10-13T13:00:00Z'),
      pool: '*',
    });
  });

  it('reads older `resets_in_seconds` records and waits for the later of two full windows', () => {
    // Counted from the record's own timestamp (09:29:41.512), not from now.
    expect(rateLimitFromCodexTranscript(fixture('rollout-rate-limits-legacy.jsonl'), UTC)).toEqual({
      message: 'Codex weekly limit reached',
      resetsAt: new Date(Date.parse('2026-10-13T09:29:41.512Z') + 302_400_000),
      pool: '*',
    });
  });

  it('finds the limit in the transcript excerpt when the output does not name it', () => {
    const payload = hookFixture('hook-transcript-only.json');
    expect(rateLimitFromCodexHook('StopFailure', payload, UTC)).toEqual({
      message: 'Codex 5-hour limit reached',
      resetsAt: new Date('2026-10-13T13:00:00Z'),
      pool: '*',
    });
    expect(codexAdapter.nextState('working', 'StopFailure', payload, UTC)).toBe('rate_limited');
  });

  it('without the excerpt the same output is a transient stream error', () => {
    const { transcript_tail: _tail, ...payload } = hookFixture('hook-transcript-only.json');
    expect(rateLimitFromCodexHook('StopFailure', payload, UTC)).toBeUndefined();
    expect(transientErrorFromCodexHook('StopFailure', payload, UTC)?.message).toContain(
      'stream disconnected before completion',
    );
  });

  it('prefers the output reset over the transcript reset', () => {
    const { message, reason } = hookFixture('hook-usage-limit-plus.json');
    const { transcript_tail } = hookFixture('hook-transcript-only.json');
    const info = rateLimitFromCodexHook('StopFailure', { message, reason, transcript_tail }, UTC);
    expect(info?.resetsAt).toEqual(new Date('2026-10-13T15:42:00Z'));
  });

  it('ignores windows below 100%, malformed lines and a corrupt excerpt', () => {
    const below = fixture('rollout-rate-limits.jsonl').replace('"used_percent":100', '"used_percent":99.5');
    expect(rateLimitFromCodexTranscript(below, UTC)).toBeUndefined();
    expect(rateLimitFromCodexTranscript('{"rate_limits":', UTC)).toBeUndefined();
    expect(rateLimitFromCodexTranscript('[1,2]', UTC)).toBeUndefined();
    const payload = {
      error: 'cli_exit',
      message: 'codex exited with code 1',
      transcript_tail: '%%not base64%%',
    };
    expect(rateLimitFromCodexHook('StopFailure', payload, UTC)).toBeUndefined();
  });
});

describe('Codex limits on screen (last signal)', () => {
  it('reads the TUI error cell, with the reset wrapped onto the next line', () => {
    expect(rateLimitFromCodexScreen(fixture('screen-usage-limit.ansi'), UTC)).toEqual({
      message:
        "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 4:10 PM.",
      resetsAt: new Date('2026-10-13T16:10:00Z'),
      pool: '*',
    });
    expect(codexAdapter.rateLimitFromScreen(fixture('screen-usage-limit.ansi'), UTC)?.resetsAt).toEqual(
      new Date('2026-10-13T16:10:00Z'),
    );
  });

  it('finds nothing on an ordinary screen', () => {
    expect(
      rateLimitFromCodexScreen('\x1b[1m>_ OpenAI Codex\x1b[0m\r\n› Ask Codex to do anything', UTC),
    ).toBeUndefined();
  });
});

describe('parseCodexResetTime', () => {
  const cases: [string, string | undefined][] = [
    ['or try again at 3:42 PM.', '2026-10-13T15:42:00.000Z'],
    // Already past today -> tomorrow.
    ['Try again at 8:15 AM.', '2026-10-14T08:15:00.000Z'],
    ['or try again at Jan 2nd, 2027 12:30 AM.', '2027-01-02T00:30:00.000Z'],
    ["You've hit your usage limit. Try again in 2 days 3 hours 15 minutes.", '2026-10-15T12:45:00.000Z'],
    ['Rate limit reached for gpt-4o. Please try again in 2.5s.', '2026-10-13T09:30:02.500Z'],
    ['Try again later.', undefined],
    ['try again at 13:61 PM', undefined],
  ];
  it.each(cases)('%s', (text, expected) => {
    expect(parseCodexResetTime(text, UTC)?.toISOString()).toBe(expected);
  });
});
