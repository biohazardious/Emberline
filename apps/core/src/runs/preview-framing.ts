/**
 * Whether a running container preview lets the Live Browser frame it: curl (in the runner, via
 * `execCommand`) reads the response headers of the preview root and `X-Frame-Options` / CSP
 * `frame-ancestors` decide. Only what the headers state is judged; anything else is `unknown`.
 */
import type { PreviewFraming } from '@emberline/protocol';
import { execCommand } from '../command-exec.js';

const UNKNOWN: PreviewFraming = { state: 'unknown', reason: null };
const ALLOWED: PreviewFraming = { state: 'allowed', reason: null };
const NEUTRAL_CWD = '/';
const PROBE_TIMEOUT_MS = 10_000;

/** From `curl -D -` output: the last header block decides (a `100 Continue` block before it is ignored). */
export function framingFromHeaders(raw: string): PreviewFraming {
  const blocks = raw.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/\S+ \d{3}/.test(block.trimStart()));
  const last = blocks.at(-1);
  if (!last) return UNKNOWN;
  const [statusLine = '', ...lines] = last.trimStart().split(/\r?\n/);
  if (/^HTTP\/\S+ 3\d\d/.test(statusLine)) return UNKNOWN;

  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
  }

  const ancestors: string[][] = [];
  for (const value of headers.get('content-security-policy') ?? []) {
    for (const directive of value.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() === 'frame-ancestors') ancestors.push(sources);
    }
  }
  if (ancestors.length > 0) {
    const refusing = ancestors.find((sources) => {
      const lower = sources.map((s) => s.toLowerCase());
      return lower.length > 0 && (lower.every((s) => s === "'none'") || lower.every((s) => s === "'self'"));
    });
    if (refusing)
      return { state: 'refused', reason: `Content-Security-Policy: frame-ancestors ${refusing.join(' ')}` };
    return ancestors.every((sources) => sources.includes('*')) ? ALLOWED : UNKNOWN;
  }

  const xfo = headers.get('x-frame-options')?.[0];
  if (xfo === undefined) return ALLOWED;
  const value = xfo.toUpperCase();
  return value === 'DENY' || value === 'SAMEORIGIN'
    ? { state: 'refused', reason: `X-Frame-Options: ${value}` }
    : UNKNOWN;
}

/** Asks the preview root (as the runner reaches it) for its headers; any failure is `unknown`. */
export async function probePreviewFraming(url: string): Promise<PreviewFraming> {
  try {
    const result = await execCommand({
      file: 'curl',
      args: ['-s', '--noproxy', '*', '-o', '/dev/null', '-D', '-', '--max-time', '5', url],
      cwd: NEUTRAL_CWD,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return framingFromHeaders(result.stdout);
  } catch {
    return UNKNOWN;
  }
}

export class PreviewFramingCache {
  private readonly entries = new Map<string, { startKey: string; promise: Promise<PreviewFraming> }>();

  /** One probe per (target, start): `startKey` changes with each start; concurrent callers share the probe. */
  get(target: string, startKey: string, url: string): Promise<PreviewFraming> {
    const known = this.entries.get(target);
    if (known && known.startKey === startKey) return known.promise;
    const promise = probePreviewFraming(url);
    this.entries.set(target, { startKey, promise });
    return promise;
  }

  forget(target: string): void {
    this.entries.delete(target);
  }
}
