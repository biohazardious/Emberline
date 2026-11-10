import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmTemp } from '../test-rm.js';
import { MAX_LINE_BYTES, MAX_SMALL_FILE_BYTES, readClaudeUsage } from './claude-usage.js';

let root: string;
let home: string;
const now = Date.parse('2026-11-10T12:00:00.000Z');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'claude-usage-'));
  home = path.join(root, 'home');
  mkdirSync(path.join(home, '.claude', 'projects', 'p1'), { recursive: true });
});
afterEach(() => rmTemp(root));

const write = (rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  writeFileSync(path.join(home, rel), content);
};
const turn = (id: string, minutesAgo: number, usage: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    message: { id, usage },
  });
const credentials = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-secret',
    refreshToken: 'sk-ant-ort-secret',
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    expiresAt: now + 3_600_000,
  },
});
const limits = JSON.stringify({
  fiveHour: { utilizationPercent: 42, resetsAt: '2026-11-10T14:00:00.000Z', severity: 'normal' },
  sevenDay: { utilizationPercent: 7, resetsAt: null, severity: 'normal' },
  extraUsage: null,
  updatedAt: '2026-11-10T11:59:00.000Z',
});

describe('readClaudeUsage', () => {
  it('readClaudeUsage reads credentials, project logs and the rate-limit file', async () => {
    write('.claude/.credentials.json', credentials);
    write('.claude/emberline-rate-limits.json', limits);
    write(
      '.claude/projects/p1/session.jsonl',
      [
        turn('m1', 30, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
        turn('m1', 30, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }), // the same message again
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        turn('m2', 5 * 60, { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 }),
        turn('m3', 3 * 24 * 60, { input_tokens: 1000, output_tokens: 0 }),
        turn('m4', 9 * 24 * 60, { input_tokens: 99_999 }), // older than a week
      ].join('\n'),
    );

    const usage = await readClaudeUsage(home, now);
    expect(usage).toMatchObject({
      available: true,
      authenticated: true,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      tokenExpiresAt: new Date(now + 3_600_000).toISOString(),
      fiveHour: { utilizationPercent: 42, resetsAt: '2026-11-10T14:00:00.000Z', severity: 'normal' },
      sevenDay: { utilizationPercent: 7, resetsAt: null, severity: 'normal' },
      extraUsage: null,
      limitsUpdatedAt: '2026-11-10T11:59:00.000Z',
      updatedAt: new Date(now).toISOString(),
    });
    expect(usage?.hourlyTokens).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 0,
      totalTokens: 115,
      turnCount: 1,
    });
    expect(usage?.dailyTokens.totalTokens).toBe(121);
    expect(usage?.dailyTokens.turnCount).toBe(2);
    expect(usage?.weeklyTokens.totalTokens).toBe(1121);
    expect(usage?.weeklyTokens.turnCount).toBe(3);
    // The tokens in the credentials file are never part of the answer.
    expect(JSON.stringify(usage)).not.toMatch(/sk-ant/);
  });

  it('oversized or malformed files give null fields, never throw', async () => {
    write('.claude/.credentials.json', credentials + ' '.repeat(MAX_SMALL_FILE_BYTES));
    write('.claude/emberline-rate-limits.json', '{"fiveHour": {"utilizationPercent": 4');
    write(
      '.claude/projects/p1/a.jsonl',
      [
        'not json "usage"',
        JSON.stringify({ usage: 'lots' }),
        turn('n1', 10, { input_tokens: -5, output_tokens: 'NaN', cache_read_input_tokens: 1e300 }),
        // A line over the cap is skipped as a whole; the next one still counts.
        turn('big', 10, { input_tokens: 1, pad: 'x'.repeat(MAX_LINE_BYTES) }),
        turn('n2', 10, { input_tokens: 4, output_tokens: 1 }),
      ].join('\n'),
    );
    // A FIFO where a transcript would be never blocks the scan.
    execFileSync('mkfifo', [path.join(home, '.claude/projects/p1/fifo.jsonl')]);

    const usage = await readClaudeUsage(home, now);
    expect(usage).toMatchObject({
      available: true,
      authenticated: false,
      subscriptionType: null,
      rateLimitTier: null,
      tokenExpiresAt: null,
      fiveHour: null,
      sevenDay: null,
      extraUsage: null,
      limitsUpdatedAt: null,
    });
    // n1 counts as a turn without tokens (nothing negative, nothing absurd); n2 counts in full.
    expect(usage?.hourlyTokens).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
      totalTokens: 5,
      turnCount: 2,
    });
    expect(usage?.hourlyTokens.cacheReadTokens).toBe(0);

    // Limits of the wrong shape are dropped one by one.
    write(
      '.claude/emberline-rate-limits.json',
      JSON.stringify({
        fiveHour: { utilizationPercent: 'all' },
        sevenDay: { utilizationPercent: 3, resetsAt: null },
      }),
    );
    write(
      '.claude/.credentials.json',
      JSON.stringify({ claudeAiOauth: { accessToken: 'x', subscriptionType: { a: 1 } } }),
    );
    const second = await readClaudeUsage(home, now);
    expect(second).toMatchObject({
      authenticated: true,
      subscriptionType: null,
      fiveHour: null,
      sevenDay: { utilizationPercent: 3, resetsAt: null, severity: 'normal' },
    });

    // No runner home at all (no runner-home mount): nothing to report.
    await expect(readClaudeUsage(path.join(root, 'missing'), now)).resolves.toBeNull();
  });

  it('a symlink in .claude pointing outside is not followed', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(path.join(outside, 'proj'), { recursive: true });
    writeFileSync(path.join(outside, 'creds.json'), credentials);
    writeFileSync(path.join(outside, 'limits.json'), limits);
    writeFileSync(path.join(outside, 't.jsonl'), turn('o1', 10, { input_tokens: 7 }));
    writeFileSync(path.join(outside, 'proj', 's.jsonl'), turn('o2', 10, { input_tokens: 9 }));
    symlinkSync(path.join(outside, 'creds.json'), path.join(home, '.claude/.credentials.json'));
    symlinkSync(path.join(outside, 'limits.json'), path.join(home, '.claude/emberline-rate-limits.json'));
    symlinkSync(path.join(outside, 't.jsonl'), path.join(home, '.claude/projects/p1/linked.jsonl'));
    symlinkSync(path.join(outside, 'proj'), path.join(home, '.claude/projects/linked-dir'));

    const usage = await readClaudeUsage(home, now);
    expect(usage).toMatchObject({
      authenticated: false,
      fiveHour: null,
      sevenDay: null,
      limitsUpdatedAt: null,
    });
    expect(usage?.weeklyTokens.turnCount).toBe(0);

    // `.claude` itself a link: nothing behind it is read either.
    rmTemp(path.join(home, '.claude'));
    mkdirSync(path.join(outside, 'claude', 'projects', 'p'), { recursive: true });
    writeFileSync(path.join(outside, 'claude', '.credentials.json'), credentials);
    writeFileSync(
      path.join(outside, 'claude', 'projects', 'p', 's.jsonl'),
      turn('o3', 10, { input_tokens: 9 }),
    );
    symlinkSync(path.join(outside, 'claude'), path.join(home, '.claude'));
    const viaLink = await readClaudeUsage(home, now);
    expect(viaLink).toMatchObject({ authenticated: false });
    expect(viaLink?.weeklyTokens.turnCount).toBe(0);
  });
});
