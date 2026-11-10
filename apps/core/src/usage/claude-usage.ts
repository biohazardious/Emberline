/**
 * The usage and limits panel's data (Claude's plan, its 5-hour and 7-day limits, and the token counts
 * of Claude's and Antigravity's transcripts), read by core from the runner's home: the runner-home
 * volume, mounted read-only at {@link RUNNER_HOME}.
 *
 * Everything there is the agents' to write, so it is read as untrusted input: a file is opened only
 * through a descriptor that names exactly the expected path below the real home (no link anywhere
 * below it is followed, `.claude` itself included), it must be a regular file (a FIFO or a device
 * is never read), small files are read only up to {@link MAX_SMALL_FILE_BYTES}, transcripts only
 * their newest {@link MAX_TRANSCRIPT_BYTES} within one scan's {@link MAX_SCAN_BYTES}, a line over
 * {@link MAX_LINE_BYTES} is skipped, every JSON parse is guarded, and only values of the expected
 * type and shape are kept. The credentials file's tokens are never part of the answer.
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  type ClaudeTokenBucket,
  ClaudeUsageTelemetry,
  type ProviderTokenTelemetry,
} from '@emberline/protocol';
import { type OpenedFile, openVerifiedFile } from '../outputs/safe-fs.js';

/** What the Claude part of the panel shows: {@link ClaudeUsageTelemetry} without the other providers. */
export type ClaudeUsage = Omit<ClaudeUsageTelemetry, 'providerTokens'>;

/** Where core sees the runner's home (compose: `runner-home:/home/node:ro`). */
export const RUNNER_HOME = '/home/node';

export const MAX_SMALL_FILE_BYTES = 64 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_SCAN_BYTES = 512 * 1024 * 1024;
/** Transcripts looked at per scan at most (the newest). */
const MAX_FILES = 2_000;
const CHUNK = 1024 * 1024;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** A non-empty string of at most 200 characters, else null. */
const shortString = (v: unknown): string | null => (typeof v === 'string' && v && v.length <= 200 ? v : null);
/** A turn's token count: a whole number from 0 to a billion (no turn comes near), else 0. */
const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e9 ? Math.floor(n) : 0;
};

function emptyBucket(): ClaudeTokenBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    turnCount: 0,
  };
}

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function addTokens(bucket: ClaudeTokenBucket, t: Tokens): void {
  bucket.inputTokens += t.input;
  bucket.outputTokens += t.output;
  bucket.cacheReadTokens += t.cacheRead;
  bucket.cacheCreationTokens += t.cacheCreation;
  bucket.totalTokens += t.input + t.output + t.cacheRead + t.cacheCreation;
  bucket.turnCount += 1;
}

/** `rel` below the real home, opened as {@link openVerifiedFile} does; null when missing or refused. */
async function openUnder(realHome: string, rel: string): Promise<OpenedFile | null> {
  const abs = path.join(realHome, rel);
  return openVerifiedFile(abs, abs).catch(() => null);
}

/** The parsed JSON of a small file below the home; undefined when missing, refused, too large or malformed. */
async function readSmallJson(realHome: string, rel: string): Promise<unknown> {
  const opened = await openUnder(realHome, rel);
  if (!opened) return undefined;
  try {
    // Read up to one byte past the cap whatever fstat said: the file may grow meanwhile.
    const buffer = Buffer.alloc(MAX_SMALL_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SMALL_FILE_BYTES) return undefined;
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
  } catch {
    return undefined;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Each line of the newest `maxBytes` of an open file (a tail's cut first line is dropped), skipping
 * lines over {@link MAX_LINE_BYTES}. Resolves with the bytes read.
 */
async function forEachLine(
  { handle, size }: OpenedFile,
  maxBytes: number,
  onLine: (line: string, index: number) => void,
): Promise<number> {
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(CHUNK);
  let parts: Buffer[] = [];
  let partLength = 0;
  let overflow = false;
  let skip = start > 0;
  let index = 0;
  const emit = () => {
    if (!overflow && !skip) onLine(Buffer.concat(parts).toString('utf8'), index++);
    parts = [];
    partLength = 0;
    overflow = false;
    skip = false;
  };
  const keep = (piece: Buffer) => {
    if (overflow || piece.length === 0) return;
    if (partLength + piece.length > MAX_LINE_BYTES) {
      overflow = true;
      parts = [];
      partLength = 0;
      return;
    }
    parts.push(Buffer.from(piece));
    partLength += piece.length;
  };
  let position = start;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - position), position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    let from = 0;
    for (let nl = chunk.indexOf(10, from); nl !== -1; nl = chunk.indexOf(10, from)) {
      keep(chunk.subarray(from, nl));
      emit();
      from = nl + 1;
    }
    keep(chunk.subarray(from));
  }
  if (partLength > 0 || overflow) emit();
  return position - start;
}

const listDir = (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch(() => []);

interface Candidate {
  rel: string;
  mtimeMs: number;
}

/** Regular files (by lstat: a link is none) changed since `cutoff`, newest first, at most {@link MAX_FILES}. */
async function recentFiles(realHome: string, rels: string[], cutoff: number): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const rel of rels) {
    const stats = await lstat(path.join(realHome, rel)).catch(() => null);
    if (stats?.isFile() && stats.mtimeMs >= cutoff) found.push({ rel, mtimeMs: stats.mtimeMs });
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

/** Runs `onLine` over each candidate's lines within the scan's byte budget, newest file first. */
async function scanLines(
  realHome: string,
  files: Candidate[],
  onLine: (line: string, file: Candidate, index: number) => void,
): Promise<void> {
  let budget = MAX_SCAN_BYTES;
  for (const file of files) {
    if (budget <= 0) break;
    const opened = await openUnder(realHome, file.rel);
    if (!opened) continue;
    try {
      budget -= await forEachLine(opened, Math.min(MAX_TRANSCRIPT_BYTES, budget), (line, i) =>
        onLine(line, file, i),
      );
    } catch {
      // A file that cannot be read is left out.
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
}

/** Claude's transcripts (`.claude/projects/<project>/<session>.jsonl`) of the last 7 days, deduplicated by message. */
async function claudeTokens(realHome: string, now: number): Promise<ProviderTokenTelemetry> {
  const hourly = emptyBucket();
  const daily = emptyBucket();
  const weekly = emptyBucket();
  const cutoff = now - 7 * DAY;
  const rels: string[] = [];
  for (const dir of await listDir(path.join(realHome, '.claude', 'projects'))) {
    if (!dir.isDirectory()) continue;
    for (const file of await listDir(path.join(realHome, '.claude', 'projects', dir.name))) {
      if (file.isFile() && file.name.endsWith('.jsonl'))
        rels.push(path.join('.claude', 'projects', dir.name, file.name));
    }
  }
  const byMessage = new Map<string, { ts: number; tokens: Tokens }>();
  await scanLines(realHome, await recentFiles(realHome, rels, cutoff), (line, file, i) => {
    if (!line.includes('"usage"')) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(obj)) return;
    const message = isRecord(obj.message) ? obj.message : null;
    const usage = message && isRecord(message.usage) ? message.usage : obj.usage;
    if (!isRecord(usage)) return;
    const ts = typeof obj.timestamp === 'string' && obj.timestamp ? Date.parse(obj.timestamp) : file.mtimeMs;
    if (!Number.isFinite(ts) || ts < cutoff) return;
    const key = shortString(message?.id) ?? shortString(obj.uuid) ?? `${file.rel}:${i}`;
    byMessage.set(key, {
      ts,
      tokens: {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheCreation: count(usage.cache_creation_input_tokens),
      },
    });
  });
  for (const { ts, tokens } of byMessage.values()) {
    addTokens(weekly, tokens);
    if (ts >= now - DAY) addTokens(daily, tokens);
    if (ts >= now - HOUR) addTokens(hourly, tokens);
  }
  return { hourlyTokens: hourly, dailyTokens: daily, weeklyTokens: weekly };
}

/** Antigravity's transcripts (`.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`) of the last 7 days. */
async function antigravityTokens(realHome: string, now: number): Promise<ProviderTokenTelemetry> {
  const hourly = emptyBucket();
  const daily = emptyBucket();
  const weekly = emptyBucket();
  const cutoff = now - 7 * DAY;
  const brain = path.join('.gemini', 'antigravity-cli', 'brain');
  const rels = (await listDir(path.join(realHome, brain)))
    .filter((d) => d.isDirectory())
    .map((d) => path.join(brain, d.name, '.system_generated', 'logs', 'transcript.jsonl'));
  await scanLines(realHome, await recentFiles(realHome, rels, cutoff), (line, file) => {
    if (!line.includes('"PLANNER_RESPONSE"')) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(obj) || obj.type !== 'PLANNER_RESPONSE') return;
    const ts =
      typeof obj.created_at === 'string' && obj.created_at ? Date.parse(obj.created_at) : file.mtimeMs;
    if (!Number.isFinite(ts) || ts < cutoff) return;
    const tokens = {
      input: count(obj.input_tokens),
      output: count(obj.output_tokens),
      cacheRead: count(obj.cache_read_tokens),
      cacheCreation: 0,
    };
    if (tokens.input + tokens.output + tokens.cacheRead <= 0) return;
    addTokens(weekly, tokens);
    if (ts >= now - DAY) addTokens(daily, tokens);
    if (ts >= now - HOUR) addTokens(hourly, tokens);
  });
  return { hourlyTokens: hourly, dailyTokens: daily, weeklyTokens: weekly };
}

const realHomeOf = (homeDir: string): Promise<string | null> => realpath(homeDir).catch(() => null);

/**
 * Claude's plan (from `.claude/.credentials.json`; its tokens are never used or returned), its
 * limits as the CLI reported them to its status line (`.claude/emberline-rate-limits.json`, kept by
 * claude-statusline.mjs) and the token counts of its transcripts. Null when there is no home to
 * read (no runner-home mount); a missing, refused or malformed file gives null fields.
 */
export async function readClaudeUsage(homeDir: string, now = Date.now()): Promise<ClaudeUsage | null> {
  const realHome = await realHomeOf(homeDir);
  if (!realHome) return null;

  const [creds, limits, tokens] = await Promise.all([
    readSmallJson(realHome, path.join('.claude', '.credentials.json')),
    readSmallJson(realHome, path.join('.claude', 'emberline-rate-limits.json')),
    claudeTokens(realHome, now),
  ]);

  const oauth = isRecord(creds) && isRecord(creds.claudeAiOauth) ? creds.claudeAiOauth : null;
  const authenticated = Boolean(oauth?.accessToken);
  let tokenExpiresAt: string | null = null;
  if (authenticated && (typeof oauth?.expiresAt === 'number' || typeof oauth?.expiresAt === 'string')) {
    const expires = new Date(oauth.expiresAt);
    if (!Number.isNaN(expires.getTime())) tokenExpiresAt = expires.toISOString();
  }
  const limit = <K extends 'fiveHour' | 'sevenDay' | 'extraUsage'>(key: K): ClaudeUsageTelemetry[K] => {
    const parsed = ClaudeUsageTelemetry.shape[key].safeParse(isRecord(limits) ? limits[key] : undefined);
    return (parsed.success ? parsed.data : null) as ClaudeUsageTelemetry[K];
  };

  return {
    available: true,
    authenticated,
    subscriptionType: authenticated ? shortString(oauth?.subscriptionType) : null,
    rateLimitTier: authenticated ? shortString(oauth?.rateLimitTier) : null,
    tokenExpiresAt,
    fiveHour: limit('fiveHour'),
    sevenDay: limit('sevenDay'),
    extraUsage: limit('extraUsage'),
    hourlyTokens: tokens.hourlyTokens,
    dailyTokens: tokens.dailyTokens,
    weeklyTokens: tokens.weeklyTokens,
    limitsUpdatedAt: isRecord(limits) ? shortString(limits.updatedAt) : null,
    updatedAt: new Date(now).toISOString(),
  };
}

const CACHE_MS = 25_000;
let cached: { homeDir: string; at: number; value: ClaudeUsageTelemetry } | null = null;
let pending: { homeDir: string; promise: Promise<ClaudeUsageTelemetry> } | null = null;

async function readTelemetry(homeDir: string): Promise<ClaudeUsageTelemetry> {
  const now = Date.now();
  const realHome = await realHomeOf(homeDir);
  const agy = realHome
    ? await antigravityTokens(realHome, now)
    : { hourlyTokens: emptyBucket(), dailyTokens: emptyBucket(), weeklyTokens: emptyBucket() };
  const claude = await readClaudeUsage(homeDir, now);
  const base: ClaudeUsage = claude ?? {
    available: false,
    authenticated: false,
    subscriptionType: null,
    rateLimitTier: null,
    tokenExpiresAt: null,
    fiveHour: null,
    sevenDay: null,
    extraUsage: null,
    hourlyTokens: emptyBucket(),
    dailyTokens: emptyBucket(),
    weeklyTokens: emptyBucket(),
    updatedAt: new Date(now).toISOString(),
  };
  return {
    ...base,
    providerTokens: {
      claude: {
        hourlyTokens: base.hourlyTokens,
        dailyTokens: base.dailyTokens,
        weeklyTokens: base.weeklyTokens,
      },
      antigravity: agy,
      gemini: agy,
    },
  };
}

/**
 * The panel's answer (`/api/factory/claude-usage`): {@link readClaudeUsage} plus Antigravity's token
 * counts, kept for 25 s (a scan reads up to {@link MAX_SCAN_BYTES}); `forceRefresh` reads afresh.
 * Concurrent requests share one scan.
 */
export async function claudeUsageTelemetry(
  homeDir: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<ClaudeUsageTelemetry> {
  if (!opts.forceRefresh && cached?.homeDir === homeDir && Date.now() - cached.at < CACHE_MS)
    return cached.value;
  if (pending?.homeDir === homeDir) return pending.promise;
  const promise = readTelemetry(homeDir).then((value) => {
    cached = { homeDir, at: Date.now(), value };
    return value;
  });
  pending = { homeDir, promise };
  try {
    return await promise;
  } finally {
    if (pending?.promise === promise) pending = null;
  }
}
