import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Agent transcripts live here (the runner's home, mounted read-only into core at the same path). */
export const TRANSCRIPTS_ROOT = '/home/node/.claude/projects';
/** Larger transcripts are not parsed for telemetry (estimates are used instead). */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * S9: `transcript_path` arrives in hook payloads written by the agent, so it is only accepted when it
 * names a `.jsonl` file under the transcripts root (no `/dev/zero`, no files elsewhere).
 */
export function isAcceptableTranscriptPath(candidate: string, root = TRANSCRIPTS_ROOT): boolean {
  if (!path.isAbsolute(candidate) || !candidate.endsWith('.jsonl')) return false;
  const normalized = path.normalize(candidate);
  return normalized === candidate && normalized.startsWith(`${root}/`);
}

interface CacheEntry {
  ino: number;
  offset: number;
  /** Bytes after the last newline, completed by the next read. */
  carry: string;
  usage: TranscriptUsage;
}

const cache = new Map<string, CacheEntry>();

function addLine(usage: TranscriptUsage, line: string): void {
  if (!line.includes('"usage"')) return;
  try {
    const parsed = JSON.parse(line) as {
      message?: { usage?: Record<string, number> };
      usage?: Record<string, number>;
    };
    const u = parsed.message?.usage ?? parsed.usage;
    if (!u) return;
    usage.inputTokens += Number(u.input_tokens ?? 0);
    usage.outputTokens += Number(u.output_tokens ?? 0);
    usage.cachedTokens += Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
  } catch {
    // Partial or malformed line.
  }
}

/**
 * Token totals of a transcript. B15: results are cached per file and only the bytes appended since
 * the last call are read, so listing runs no longer re-reads every transcript from the start.
 */
export function readTranscriptUsage(filePath: string, root = TRANSCRIPTS_ROOT): TranscriptUsage | null {
  if (!isAcceptableTranscriptPath(filePath, root)) return null;
  let fd: number | undefined;
  try {
    // The real path must stay inside the root too (a symlink planted by an agent).
    const real = realpathSync(filePath);
    if (!real.startsWith(`${realpathSync(root)}/`)) return null;
    fd = openSync(real, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;

    let entry = cache.get(real);
    if (!entry || entry.ino !== stat.ino || stat.size < entry.offset) {
      entry = { ino: stat.ino, offset: 0, carry: '', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
      cache.set(real, entry);
    }
    if (stat.size > entry.offset) {
      const buffer = Buffer.alloc(stat.size - entry.offset);
      const read = readSync(fd, buffer, 0, buffer.length, entry.offset);
      entry.offset += read;
      const text = entry.carry + buffer.subarray(0, read).toString('utf8');
      const lines = text.split('\n');
      entry.carry = lines.pop() ?? '';
      for (const line of lines) addLine(entry.usage, line);
    }
    return { ...entry.usage };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Only the tail of a transcript is searched for the final answer. */
const FINAL_TEXT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The text of the agent's last assistant message, read from the end of its transcript. Hook payloads
 * only carry a truncated copy in older runs, so this is how the full final answer is recovered.
 */
export function readLastAssistantText(filePath: string, root = TRANSCRIPTS_ROOT): string | null {
  if (!isAcceptableTranscriptPath(filePath, root)) return null;
  let fd: number | undefined;
  try {
    const real = realpathSync(filePath);
    if (!real.startsWith(`${realpathSync(root)}/`)) return null;
    fd = openSync(real, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, FINAL_TEXT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line?.includes('"assistant"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
        const text = (entry.message.content as { type?: string; text?: unknown }[])
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join('\n')
          .trim();
        if (text) return text;
      } catch {
        // The first line of the tail can be cut in half; skip anything unparsable.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
