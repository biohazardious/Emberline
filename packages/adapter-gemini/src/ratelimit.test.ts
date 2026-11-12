/**
 * Fixtures: Gemini CLI 0.68.0 output (`[API Error: <message> (Status: <status>)]`, the raw Google
 * API error body, and the interactive "Usage limit reached for <model>." / "Access resets at
 * <h:mm AM zone>." item, taken from the published bundle) with the Code Assist and Gemini API quota
 * messages, shaped the way they reach core: the wrapper's `StopFailure` payload or a ptyd snapshot.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { geminiAdapter } from './index.js';
import {
  parseGeminiResetTime,
  rateLimitFromGeminiHook,
  rateLimitFromGeminiScreen,
  transientErrorFromGeminiHook,
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

describe('Gemini limits from the failure hook', () => {
  it('reads the Code Assist capacity message and its relative reset', () => {
    const payload = hookFixture('hook-code-assist-capacity.json');
    expect(rateLimitFromGeminiHook('StopFailure', payload, UTC)).toEqual({
      message: 'You have exhausted your capacity on this model. Your quota will reset after 2h31m12s.',
      resetsAt: new Date(NOW.getTime() + (2 * 3600 + 31 * 60 + 12) * 1000),
      pool: '*',
    });
    // "this model" is the run's own: its pool waits, other Gemini models keep running.
    expect(rateLimitFromGeminiHook('StopFailure', payload, { ...UTC, model: 'gemini-pro' })?.pool).toBe(
      'gemini-pro',
    );
    expect(geminiAdapter.nextState('working', 'StopFailure', payload, UTC)).toBe('rate_limited');
    expect(transientErrorFromGeminiHook('StopFailure', payload, UTC)).toBeUndefined();
  });

  it('reads the Gemini API key quota from the raw error body, with the model pool and retry delay', () => {
    expect(rateLimitFromGeminiHook('StopFailure', hookFixture('hook-api-key-quota.json'), UTC)).toEqual({
      message:
        'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50, model: gemini-2.5-pro nPlease retry in 38.06s.',
      resetsAt: new Date(NOW.getTime() + 38_060),
      pool: 'gemini-pro',
    });
  });

  it('a model without any quota on this tier (limit: 0) never resets: no limit, no retry', () => {
    const payload = hookFixture('hook-no-free-tier.json');
    expect(rateLimitFromGeminiHook('StopFailure', payload, UTC)).toBeUndefined();
    expect(transientErrorFromGeminiHook('StopFailure', payload, UTC)).toBeUndefined();
    expect(geminiAdapter.nextState('working', 'StopFailure', payload, UTC)).toBe('waiting_input');
  });

  it('retries an overloaded model instead of waiting for a quota', () => {
    const payload = hookFixture('hook-overloaded.json');
    expect(rateLimitFromGeminiHook('StopFailure', payload, UTC)).toBeUndefined();
    expect(transientErrorFromGeminiHook('StopFailure', payload, UTC)?.message).toContain(
      'The model is overloaded',
    );
  });

  it('keeps the shared 429 rules: an explicit 429 pointing at billing details is a limit, hard billing is not', () => {
    const softBilling =
      '[API Error: got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}]';
    expect(
      rateLimitFromGeminiHook('StopFailure', { error: 'cli_exit', message: softBilling }, UTC),
    ).toMatchObject({
      message: 'Error: got status: 429 Too Many Requests.',
      pool: '*',
    });
    for (const message of [
      'RESOURCE_EXHAUSTED (code 429): insufficient_quota',
      'status 429 payment required',
    ]) {
      expect(
        rateLimitFromGeminiHook('StopFailure', { error: 'cli_exit', message }, UTC),
        message,
      ).toBeUndefined();
    }
    for (const message of ['AssertionError: expected 429 but got 200', 'tests: 429 passed']) {
      expect(
        rateLimitFromGeminiHook('StopFailure', { error: 'cli_exit', message }, UTC),
        message,
      ).toBeUndefined();
    }
  });

  it('ignores a clean exit', () => {
    expect(rateLimitFromGeminiHook('Stop', {}, UTC)).toBeUndefined();
    expect(geminiAdapter.nextState('working', 'Stop', {}, UTC)).toBe('done');
  });
});

describe('Gemini limits on screen', () => {
  it('reads the interactive limit item, its reset on the next line in the printed offset zone', () => {
    expect(rateLimitFromGeminiScreen(fixture('screen-usage-limit.ansi'), UTC)).toEqual({
      message: 'Usage limit reached for gemini-2.5-pro.',
      resetsAt: new Date('2026-10-13T12:45:00Z'),
      pool: 'gemini-pro',
    });
    expect(geminiAdapter.rateLimitFromScreen(fixture('screen-usage-limit.ansi'), UTC)?.pool).toBe(
      'gemini-pro',
    );
  });

  it('finds nothing on an ordinary screen', () => {
    expect(rateLimitFromGeminiScreen('\x1b[32m✦\x1b[0m Done. All checks pass.\r\n', UTC)).toBeUndefined();
  });
});

describe('parseGeminiResetTime', () => {
  const cases: [string, string, string | undefined][] = [
    ['Your quota will reset after 18h43m10s.', 'UTC', '2026-10-14T04:13:10.000Z'],
    ['Please retry in 450ms.', 'UTC', '2026-10-13T09:30:00.450Z'],
    ['Access resets at 3:45 PM GMT+3.', 'UTC', '2026-10-13T12:45:00.000Z'],
    ['Access resets at 9:05 AM GMT+5:30.', 'UTC', '2026-10-14T03:35:00.000Z'],
    ['Access resets at 4:00 PM UTC.', 'Europe/Istanbul', '2026-10-13T16:00:00.000Z'],
    // An abbreviation is read in the zone the CLI ran in (the runner's).
    ['Access resets at 1:21 PM EEST.', 'Europe/Istanbul', '2026-10-13T10:21:00.000Z'],
    ['Usage limit reached for gemini-2.5-pro.', 'UTC', undefined],
  ];
  it.each(cases)('%s (%s)', (text, timeZone, expected) => {
    expect(parseGeminiResetTime(text, { now: NOW, timeZone })?.toISOString()).toBe(expected);
  });
});
