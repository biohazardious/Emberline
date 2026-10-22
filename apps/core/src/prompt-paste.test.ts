import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { stripControlChars } from './text/control-chars.js';

/** Control characters in `text` other than newline and tab (C0, DEL, C1). */
const controlsIn = (text: string) =>
  [...text].filter((ch) => {
    const c = ch.codePointAt(0)!;
    return (c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f);
  });

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  const fake = path.join(t.dir, 'fake-claude.sh');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${t.dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${t.dir}/.token-$EMBERLINE_RUN_ID" "${t.dir}/token-$EMBERLINE_RUN_ID"`,
      'sleep 20',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  t.config.claudeCommand = fake;
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ptydServer.close();
  await t.close();
});

const api = (method: 'POST', url: string, payload?: object) => t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

async function idleRun(): Promise<Run> {
  const { project } = (await api('POST', '/api/projects', { name: 'Paste' })).json();
  const run: Run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'x' })).json();
  const file = path.join(t.dir, `token-${run.id}`);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  await t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${readFileSync(file, 'utf8')}` },
    payload: { runId: run.id, event: 'SessionStart', receivedAt: new Date().toISOString(), payload: { session_id: 's' } },
  });
  return run;
}

function captureWrites(): string[] {
  const writes: string[] = [];
  const client = t.ptyd.get();
  vi.spyOn(client, 'write').mockImplementation(async (_id: string, data: string) => {
    writes.push(data);
    return {};
  });
  return writes;
}

describe('typed prompts', () => {
  it('strips controls (C0 but newline and tab, DEL, C1, ESC) and keeps the rest', () => {
    expect(stripControlChars('a\x1b[201~b\tc\nd\re\x07f\x7fg\u009bh\u0085i')).toBe('a[201~b\tc\nde' + 'fghi');
    expect(stripControlChars('a\nb\tc\x1b', '')).toBe('abc');
  });

  it('never lets pasted content end the bracketed paste', async () => {
    const run = await idleRun();
    const writes = captureWrites();
    await t.runs.sendPrompt(run.id, 'first line\nthen \x1b[201~\x1b[Z typed? \u009b201~ end');
    const paste = writes[0]!;
    expect(paste.startsWith('\x1b[200~')).toBe(true);
    expect(paste.endsWith('\x1b[201~')).toBe(true);
    expect(paste.split('\x1b[201~')).toHaveLength(2);
    expect(controlsIn(paste.slice('\x1b[200~'.length, -'\x1b[201~'.length))).toEqual([]);
    expect(paste).toContain('then [201~[Z typed? 201~ end');
  });

  it('neutralises a build-gate excerpt that carries escape sequences', async () => {
    const run = await idleRun();
    const writes = captureWrites();
    const gate = ['Build checks failed. Fix them:', '```', 'error TS2322\x1b[201~\x1b[Z', 'rm -rf /\r', '```'].join('\n');
    await t.runs.sendPrompt(run.id, gate, { automatic: true });
    expect(controlsIn(writes[0]!)).toEqual(['\x1b', '\x1b']);
    expect(writes[0]).not.toContain('\x1b[Z');
    expect(writes[0]).toContain('error TS2322[201~[Z\nrm -rf /\n```');
    // A single-line prompt is typed without a paste: it carries no controls either.
    await t.runs.sendPrompt(run.id, 'one \x1b[Z line');
    expect(writes.slice(1)).toContain('one [Z line');
    expect(writes.slice(1).join('')).not.toContain('\x1b');
  });

  it('types tabs as spaces outside a paste and keeps them inside one', async () => {
    const run = await idleRun();
    const writes = captureWrites();
    await t.runs.sendPrompt(run.id, 'col\tcol');
    expect(writes[0]).toBe('col col');
    await t.runs.sendPrompt(run.id, 'a\tb\nc');
    expect(writes).toContain('\x1b[200~a\tb\nc\x1b[201~');
  });
});
