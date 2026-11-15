import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../wrappers/agy', import.meta.url));

describe('agy wrapper', () => {
  it('without an agy sign-in it asks for one and never falls back to a gemini binary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agy-'));
    const tools = path.join(dir, 'tools');
    const bin = path.join(dir, 'bin');
    const calls = path.join(dir, 'calls');
    mkdirSync(path.join(tools, 'bin'), { recursive: true });
    mkdirSync(bin);
    for (const [file, name] of [
      [path.join(tools, 'bin', 'agy'), 'agy'],
      [path.join(bin, 'gemini'), 'gemini'],
    ] as const) {
      writeFileSync(file, `#!/bin/sh\necho ${name} >> ${JSON.stringify(calls)}\n`);
      chmodSync(file, 0o755);
    }
    const res = spawnSync('bash', [wrapper, '-p', 'hello'], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: dir,
        EMBERLINE_TOOLS_DIR: tools,
        GEMINI_API_KEY: 'k',
      },
      encoding: 'utf8',
    });
    // The sign-in files live under /home/node in the runner; they are absent here.
    if (existsSync('/home/node/.gemini/antigravity-cli/antigravity-oauth-token')) return;
    expect(res.status).toBe(41);
    expect(res.stderr).toContain('is not signed in yet');
    expect(existsSync(calls)).toBe(false);
  });
});
