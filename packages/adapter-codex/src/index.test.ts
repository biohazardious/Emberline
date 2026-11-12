import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexLaunchSpec, codexAdapter } from './index.js';

const base = { runId: 'r1234567', hookToken: 't', coreUrl: 'http://core:7420', prompt: 'do it' };
const script = (spec: { args: string[] }) => spec.args[1] ?? '';

describe('buildCodexLaunchSpec', () => {
  it('no removed --full-auto, no inner sandbox, no update offer', () => {
    const auto = buildCodexLaunchSpec({ ...base, permissionMode: 'auto' });
    expect(script(auto)).not.toContain('--full-auto');
    expect(script(auto)).toContain(
      'exec -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox',
    );
    expect(auto.env.EMBERLINE_AUTO_APPROVE).toBe('1');
    const ask = buildCodexLaunchSpec({ ...base, permissionMode: 'default' });
    expect(script(ask)).toContain('-s danger-full-access');
    expect(script(ask)).toContain('export CODEX_API_KEY="$OPENAI_API_KEY"');
    expect(ask.env.EMBERLINE_AUTO_APPROVE).toBe('0');
  });

  it('passes a chosen model through and carries no Claude-only settings', () => {
    const spec = buildCodexLaunchSpec({ ...base, model: 'o3', extraEnv: { OPENAI_API_KEY: 'sk-x' } });
    expect(script(spec)).toContain('--model o3 "$EMBERLINE_PROMPT"');
    expect(spec.env).toMatchObject({
      OPENAI_API_KEY: 'sk-x',
      EMBERLINE_PROMPT: 'do it',
      EMBERLINE_RUN_ID: 'r1234567',
    });
    expect(spec.env).not.toHaveProperty('EMBERLINE_CLAUDE_SETTINGS');
    expect(JSON.stringify(spec)).not.toContain('ticket_complete');
  });

  it('is registered as a wrapped CLI that signals completion by exit code', () => {
    expect(codexAdapter).toMatchObject({
      id: 'codex',
      displayName: 'Codex',
      hooks: 'wrapper',
      completionSignal: 'exit',
    });
    expect(codexAdapter.headlessProblem('default', true)).toBeNull();
  });
});

describe('the wrapped codex run', () => {
  /**
   * Runs the launch script in a git repo with a fake codex and a hook that records each event.
   * `rollout` (given the repo directory) is written before the run starts; the fake codex finds the
   * session directory in `$SESSIONS` and a rate-limit record to append in `$RECORD`.
   */
  function run(fakeBody: string, prompt?: string, rollout?: (dir: string) => string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-launch-'));
    execFileSync('git', ['init', '-q', dir]);
    // Outside the repo, so the worktree watcher sees no changes.
    const aux = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
    const fake = path.join(aux, 'fake-codex');
    writeFileSync(fake, `#!/bin/sh\n${fakeBody}\n`, { mode: 0o755 });
    const hook = path.join(aux, 'fake-hook');
    writeFileSync(hook, `#!/bin/sh\nprintf '%s %s\\n' "$1" "$(cat)" >> "${aux}/hooks.txt"\n`, {
      mode: 0o755,
    });
    const day = path.join(aux, '.codex', 'sessions', '2026', '10', '13');
    mkdirSync(day, { recursive: true });
    if (rollout) writeFileSync(path.join(day, 'rollout-2026-10-13T08-00-00-0198.jsonl'), rollout(dir));
    const recordFile = path.join(aux, 'record.jsonl');
    writeFileSync(recordFile, record);
    const spec = buildCodexLaunchSpec({ ...base, prompt, command: fake, hookCommand: hook });
    const res = spawnSync(spec.file, spec.args, {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', HOME: aux, SESSIONS: day, RECORD: recordFile, ...spec.env },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const hooks = (() => {
      try {
        return readFileSync(path.join(aux, 'hooks.txt'), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    })();
    return { dir, status: res.status, hooks };
  }

  const record = readFileSync(new URL('./fixtures/rollout-rate-limits.jsonl', import.meta.url), 'utf8');
  const sessionMeta = (cwd: string) => `{"type":"session_meta","payload":{"id":"0199","cwd":"${cwd}"}}\n`;

  /** A fake codex that writes a session rollout for `cwd` (shell), then fails like a dropped stream. */
  const failingCodex = (cwd: string) =>
    `printf '{"type":"session_meta","payload":{"id":"0199","cwd":"%s"}}\\n' "${cwd}" > "$SESSIONS/rollout-2026-10-13T09-12-00-0199.jsonl"; cat "$RECORD" >> "$SESSIONS/rollout-2026-10-13T09-12-00-0199.jsonl"; echo "ERROR: stream disconnected before completion"; exit 1`;

  /** The limit core reads from the run's failure hook at 09:30 UTC. */
  function failureLimit(hooks: string[]) {
    const failure = hooks.find((line) => line.startsWith('StopFailure '));
    const payload: unknown = JSON.parse(failure?.slice('StopFailure '.length) ?? '{}');
    expect(payload).toMatchObject({ error: 'cli_exit' });
    if (typeof payload !== 'object' || payload === null) throw new Error('no payload');
    const now = new Date('2026-10-13T09:30:00Z');
    return codexAdapter.rateLimitFromHook('StopFailure', { ...payload }, { now });
  }

  it('the interactive UI trusts the repository root, quoted for its config syntax', () => {
    const { dir } = run('for a in "$@"; do printf "%s\\n" "$a"; done > "$PWD/args.txt"');
    const args = readFileSync(path.join(dir, 'args.txt'), 'utf8').split('\n');
    expect(args).toContain(
      `projects."${execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel']).toString().trim()}".trust_level="trusted"`,
    );
    expect(args).toContain('check_for_update_on_startup=false');
  });

  it("a failed run carries the latest rate-limit record of its own session's rollout", () => {
    const { status, hooks } = run(failingCodex('$PWD'), 'go');
    expect(status).toBe(1);
    expect(failureLimit(hooks)).toEqual({
      message: 'Codex 5-hour limit reached',
      resetsAt: new Date('2026-10-13T13:00:00Z'),
      pool: '*',
    });
  }, 20_000);

  it("never carries another run's rollout or one written before the run started", () => {
    // A concurrent run in another directory writes its rollout while this one works.
    const foreign = run(failingCodex('/workspaces/.worktrees/other/run'), 'go');
    expect(foreign.status).toBe(1);
    expect(failureLimit(foreign.hooks)).toBeUndefined();
    // This run's directory, but a rollout from before the run (an earlier run in the same worktree).
    const earlier = run(
      'echo "ERROR: stream disconnected before completion"; exit 1',
      'go',
      (dir) => `${sessionMeta(dir)}${record}`,
    );
    expect(earlier.status).toBe(1);
    expect(failureLimit(earlier.hooks)).toBeUndefined();
  }, 40_000);

  it('a clean run reports completion through PostToolUse and Stop', () => {
    const { status, hooks } = run('echo done; exit 0', 'go');
    expect(status).toBe(0);
    expect(hooks.map((line) => line.split(' ')[0])).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
  }, 20_000);
});
