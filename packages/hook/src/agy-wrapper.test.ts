import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../wrappers/agy', import.meta.url));

/**
 * The wrapper on a runner home of its own (never the host's /home/node, which may be signed in),
 * with stand-ins for agy and a leftover gemini binary that record being called.
 */
function runWrapper(signIn: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-'));
  const home = path.join(dir, 'home');
  const tools = path.join(dir, 'tools');
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  mkdirSync(path.join(tools, 'bin'), { recursive: true });
  mkdirSync(bin);
  for (const [rel, body] of Object.entries(signIn)) {
    mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    writeFileSync(path.join(home, rel), body);
  }
  for (const [file, name] of [
    [path.join(tools, 'bin', 'agy'), 'agy'],
    [path.join(bin, 'gemini'), 'gemini'],
  ] as const) {
    writeFileSync(file, `#!/bin/sh\necho ${name} >> ${JSON.stringify(calls)}\n`);
    chmodSync(file, 0o755);
  }
  const res = spawnSync('bash', [wrapper, '--model', 'gemini-pro'], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      EMBERLINE_RUNNER_HOME: home,
      EMBERLINE_TOOLS_DIR: tools,
      GEMINI_API_KEY: 'k',
    },
    encoding: 'utf8',
  });
  const called = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  return { res, called };
}

describe('agy wrapper', () => {
  it('without an agy sign-in it asks for one and never falls back to a gemini binary', () => {
    const { res, called } = runWrapper({});
    expect(res.status).toBe(41);
    expect(res.stderr).toContain('is not signed in yet');
    expect(called).toEqual([]);
  });

  it('an empty sign-in file is no sign-in', () => {
    const { res, called } = runWrapper({ '.gemini/antigravity-cli/antigravity-oauth-token': '' });
    expect(res.status).toBe(41);
    expect(called).toEqual([]);
  });

  it.each(['.gemini/antigravity-cli/antigravity-oauth-token', '.config/antigravity/plugin-secrets.json'])(
    'signed in through %s it runs agy, never gemini',
    (file) => {
      const { res, called } = runWrapper({ [file]: '{"token":"x"}' });
      expect(res.status).toBe(0);
      expect(called).toEqual(['agy']);
    },
  );
});
