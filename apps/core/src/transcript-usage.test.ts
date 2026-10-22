import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAcceptableTranscriptPath, readTranscriptUsage } from './runs/transcript-usage.js';

let dir: string;
let root: string;
const line = (input: number, output: number) =>
  `${JSON.stringify({ message: { usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 1 } } })}\n`;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'transcripts-'));
  root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'proj'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('transcript usage', () => {
  it('only accepts .jsonl files under the transcripts root (S9)', () => {
    expect(isAcceptableTranscriptPath(`${root}/proj/a.jsonl`, root)).toBe(true);
    for (const bad of [
      '/dev/zero',
      `${root}/../secret.jsonl`,
      `${root}/proj/a.txt`,
      'relative/a.jsonl',
      `${root}x/a.jsonl`,
    ]) {
      expect(isAcceptableTranscriptPath(bad, root)).toBe(false);
    }
  });

  it('refuses a symlink that leads outside the root', () => {
    const outside = path.join(dir, 'outside.jsonl');
    writeFileSync(outside, line(5, 5));
    const link = path.join(root, 'proj', 'link.jsonl');
    symlinkSync(outside, link);
    expect(readTranscriptUsage(link, root)).toBeNull();
  });

  it('sums usage and reads only what was appended since the last call (B15)', () => {
    const file = path.join(root, 'proj', 'run.jsonl');
    writeFileSync(file, line(10, 2) + '{"type":"text"}\n');
    expect(readTranscriptUsage(file, root)).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: 1 });
    // A half-written line is held back until it is complete.
    appendFileSync(file, line(5, 1).slice(0, 20));
    expect(readTranscriptUsage(file, root)).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: 1 });
    appendFileSync(file, line(5, 1).slice(20));
    expect(readTranscriptUsage(file, root)).toEqual({ inputTokens: 15, outputTokens: 3, cachedTokens: 2 });
  });
});
