import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FactorySettings, Run } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCrossProviderCritic } from './factory/slop-guard.js';

let dir: string;
let repo: string;
const auth = (authenticated: boolean) => ({
  authenticated,
  method: 'oauth_cli' as const,
  label: 'x',
  cliInstalled: true,
  loginCommandHint: 'x',
});
const settings = {
  enabledProviders: ['claude', 'antigravity'],
  providerAuth: {
    claude: auth(true),
    antigravity: auth(true),
    gemini: auth(false),
    codex: auth(false),
    copilot: auth(false),
    aider: auth(false),
  },
} as unknown as FactorySettings;
const run = (agent: string) => ({ id: `run-${agent}`, agent }) as unknown as Run;

/** A reviewer stand-in printing the JSON envelope Claude Code / agy print in --output-format json. */
function fakeReviewer(name: string, envelope: object | null, exitCode = 0): string {
  const file = path.join(dir, name);
  const out = envelope ? JSON.stringify(envelope).replace(/'/g, `'"'"'`) : '';
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/${name}.args"\n${out ? `printf '%s' '${out}'\n` : 'echo "not logged in" >&2\n'}exit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'critic-'));
  repo = path.join(dir, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', repo, ...args]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(repo, 'math.js'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(path.join(repo, 'new-file.js'), 'export const answer = 42;\n');
});

afterEach(() => {
  delete process.env.EMBERLINE_AGY_COMMAND;
  delete process.env.EMBERLINE_CLAUDE_COMMAND;
  rmSync(dir, { recursive: true, force: true });
});

describe('cross-provider critic', () => {
  it('lets the rival CLI review the diff read-only and uses its verdict', async () => {
    process.env.EMBERLINE_AGY_COMMAND = fakeReviewer('agy', {
      status: 'SUCCESS',
      structured_output: {
        verdict: 'NEEDS_FIX',
        score: 41,
        summary: 'add() now subtracts.',
        issues: [
          {
            severity: 'critical',
            category: 'correctness',
            file: 'math.js:1',
            description: 'add returns a - b',
            fixRecommendation: 'return a + b',
          },
        ],
      },
    });
    const res = await runCrossProviderCritic({ run: run('claude'), workspacePath: repo, settings });
    expect(res).toMatchObject({ reviewerAgent: 'antigravity', reviewSource: 'rival', verdict: 'NEEDS_FIX', score: 41 });
    expect(res.issues[0]).toMatchObject({ file: 'math.js:1', severity: 'critical' });
    expect(res.followUpPrompt).toContain('[Cross-Provider Review · ANTIGRAVITY');
    const args = readFileSync(path.join(dir, 'agy.args'), 'utf8');
    expect(args).toMatch(/--mode\nplan/);
    expect(args).toContain('-export const add = (a, b) => a + b;');
    expect(args).toContain('+export const add = (a, b) => a - b;');
    expect(args).toContain('new-file.js (new, untracked)');
  });

  it('falls back to the deterministic audit and says why when the rival cannot review', async () => {
    process.env.EMBERLINE_AGY_COMMAND = fakeReviewer('agy', null, 1);
    const res = await runCrossProviderCritic({ run: run('claude'), workspacePath: repo, settings });
    expect(res.reviewSource).toBe('deterministic');
    expect(res.summary).toMatch(/Rival review by antigravity did not run: antigravity exited 1: not logged in/);
  });

  it('rejects an answer that does not match the review schema', async () => {
    process.env.EMBERLINE_AGY_COMMAND = fakeReviewer('agy', { status: 'SUCCESS', structured_output: { verdict: 'MAYBE' } });
    const res = await runCrossProviderCritic({ run: run('claude'), workspacePath: repo, settings });
    expect(res.reviewSource).toBe('deterministic');
    expect(res.summary).toContain('returned no valid structured review');
  });

  it('uses Claude in plan mode to review an Antigravity run', async () => {
    process.env.EMBERLINE_CLAUDE_COMMAND = fakeReviewer('claude', {
      type: 'result',
      is_error: false,
      structured_output: { verdict: 'PASS', score: 90, summary: 'Fine.', issues: [] },
    });
    const res = await runCrossProviderCritic({ run: run('antigravity'), workspacePath: repo, settings });
    expect(res).toMatchObject({ reviewerAgent: 'claude', reviewSource: 'rival', verdict: 'PASS' });
    expect(readFileSync(path.join(dir, 'claude.args'), 'utf8')).toMatch(/--permission-mode\nplan/);
  });
});
