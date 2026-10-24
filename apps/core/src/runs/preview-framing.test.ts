import { afterEach, describe, expect, it } from 'vitest';
import {
  type ExecRequest,
  type ExecResult,
  localCommandExecutor,
  setCommandExecutor,
  RUNNER_BIN,
} from '../command-exec.js';
import { framingFromHeaders, PreviewFramingCache } from './preview-framing.js';

const H = (...lines: string[]): string => ['HTTP/1.1 200 OK', ...lines, '', ''].join('\r\n');
const ok = (stdout: string): ExecResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
});

describe('framingFromHeaders', () => {
  it('refuses X-Frame-Options DENY and SAMEORIGIN', () => {
    expect(framingFromHeaders(H('X-Frame-Options: DENY'))).toEqual({
      state: 'refused',
      reason: 'X-Frame-Options: DENY',
    });
    expect(framingFromHeaders(H('x-frame-options: sameorigin'))).toEqual({
      state: 'refused',
      reason: 'X-Frame-Options: SAMEORIGIN',
    });
  });

  it('refuses a CSP frame-ancestors of none or only self', () => {
    expect(
      framingFromHeaders(H("Content-Security-Policy: default-src 'self'; frame-ancestors 'none'")),
    ).toEqual({
      state: 'refused',
      reason: "Content-Security-Policy: frame-ancestors 'none'",
    });
    expect(framingFromHeaders(H("Content-Security-Policy: frame-ancestors 'self'"))).toEqual({
      state: 'refused',
      reason: "Content-Security-Policy: frame-ancestors 'self'",
    });
  });

  it('allows no header and frame-ancestors *', () => {
    expect(framingFromHeaders(H('Server: x'))).toEqual({ state: 'allowed', reason: null });
    expect(framingFromHeaders(H('Content-Security-Policy: frame-ancestors *'))).toEqual({
      state: 'allowed',
      reason: null,
    });
  });

  it('lets a CSP frame-ancestors override X-Frame-Options', () => {
    expect(
      framingFromHeaders(H('Content-Security-Policy: frame-ancestors * ', 'X-Frame-Options: DENY')),
    ).toEqual({ state: 'allowed', reason: null });
  });

  it('refuses when any of two CSP headers refuses', () => {
    const raw = H(
      'Content-Security-Policy: frame-ancestors *',
      "Content-Security-Policy: frame-ancestors 'none'",
    );
    expect(framingFromHeaders(raw)).toEqual({
      state: 'refused',
      reason: "Content-Security-Policy: frame-ancestors 'none'",
    });
  });

  it('is unknown for sources it cannot judge', () => {
    expect(framingFromHeaders(H('Content-Security-Policy: frame-ancestors https://example.com'))).toEqual({
      state: 'unknown',
      reason: null,
    });
    expect(framingFromHeaders(H('X-Frame-Options: ALLOW-FROM https://x'))).toEqual({
      state: 'unknown',
      reason: null,
    });
  });

  it('reads the last header block, treats redirects as unknown and ignores report-only', () => {
    expect(framingFromHeaders(`HTTP/1.1 100 Continue\r\n\r\n${H('X-Frame-Options: DENY')}`)).toEqual({
      state: 'refused',
      reason: 'X-Frame-Options: DENY',
    });
    expect(
      framingFromHeaders(['HTTP/1.1 301 Moved Permanently', 'Location: /app', '', ''].join('\r\n')),
    ).toEqual({ state: 'unknown', reason: null });
    expect(framingFromHeaders(H("Content-Security-Policy-Report-Only: frame-ancestors 'none'"))).toEqual({
      state: 'allowed',
      reason: null,
    });
    expect(framingFromHeaders('')).toEqual({ state: 'unknown', reason: null });
    expect(framingFromHeaders('garbage')).toEqual({ state: 'unknown', reason: null });
  });
});

describe('PreviewFramingCache', () => {
  afterEach(() => setCommandExecutor(localCommandExecutor));

  function fakeCurl(body: () => Promise<ExecResult>): ExecRequest[] {
    const seen: ExecRequest[] = [];
    setCommandExecutor(async (request) => {
      seen.push(request);
      return body();
    });
    return seen;
  }

  it('shares one probe between concurrent callers of one start', async () => {
    const seen = fakeCurl(async () => ok(H('X-Frame-Options: DENY')));
    const cache = new PreviewFramingCache();
    const [a, b] = await Promise.all([
      cache.get('run:1', 'k1', 'http://h:1/'),
      cache.get('run:1', 'k1', 'http://h:1/'),
    ]);
    expect(a).toEqual({ state: 'refused', reason: 'X-Frame-Options: DENY' });
    expect(b).toBe(a);
    expect(seen).toHaveLength(1);
    // The image's curl with no runner environment; `-q` first, so no ~/.curlrc applies.
    expect(seen[0]?.file).toBe(RUNNER_BIN.curl);
    expect(seen[0]?.inheritEnv).toBe(false);
    expect(seen[0]?.args).toEqual([
      '-q',
      '-s',
      '--noproxy',
      '*',
      '-o',
      '/dev/null',
      '-D',
      '-',
      '--max-time',
      '5',
      'http://h:1/',
    ]);
    await cache.get('run:1', 'k1', 'http://h:1/');
    expect(seen).toHaveLength(1);
  });

  it('probes again for a new start key and after forget', async () => {
    const seen = fakeCurl(async () => ok(H()));
    const cache = new PreviewFramingCache();
    await cache.get('run:1', 'k1', 'http://h:1/');
    await cache.get('run:1', 'k2', 'http://h:1/');
    expect(seen).toHaveLength(2);
    cache.forget('run:1');
    await cache.get('run:1', 'k2', 'http://h:1/');
    expect(seen).toHaveLength(3);
  });

  it('answers unknown when curl throws', async () => {
    fakeCurl(async () => Promise.reject(new Error('no runner')));
    expect(await new PreviewFramingCache().get('run:1', 'k', 'http://h:1/')).toEqual({
      state: 'unknown',
      reason: null,
    });
  });

  it('does not keep an answer-less probe for the start: it is retried after a short interval, never more often', async () => {
    let calls = 0;
    const seen = fakeCurl(async () => {
      calls += 1;
      return calls === 1 ? { ...ok(''), exitCode: 7 } : ok(H('X-Frame-Options: DENY'));
    });
    let now = 1_000;
    const cache = new PreviewFramingCache(() => now, 3_000);
    expect(await cache.get('run:1', 'k', 'http://h:1/')).toEqual({ state: 'unknown', reason: null });
    now += 1_000;
    expect(await cache.get('run:1', 'k', 'http://h:1/')).toEqual({ state: 'unknown', reason: null });
    expect(seen).toHaveLength(1);
    now += 2_500;
    expect(await cache.get('run:1', 'k', 'http://h:1/')).toEqual({
      state: 'refused',
      reason: 'X-Frame-Options: DENY',
    });
    expect(seen).toHaveLength(2);
    now += 60_000;
    await cache.get('run:1', 'k', 'http://h:1/');
    expect(seen).toHaveLength(2);
  });
});
