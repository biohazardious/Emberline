import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrappers = fileURLToPath(new URL('../wrappers/', import.meta.url));

function run(script: string, home: string, env: Record<string, string> = {}, args: string[] = []) {
  const res = spawnSync(process.execPath, [path.join(wrappers, script), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
    encoding: 'utf8',
  });
  expect(res.status).toBe(0);
}

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('claude-seed', () => {
  it('pre-answers one-time dialogs but keeps onboarding until there is a login', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 7, theme: 'dark' }));
    run('claude-seed.mjs', home);
    const config = json(path.join(home, '.claude.json'));
    expect(config).toMatchObject({ numStartups: 7, theme: 'dark', resumeReturnDismissed: true, lspRecommendationDisabled: true });
    expect(config.hasCompletedOnboarding).toBeUndefined();
    expect(config).toMatchObject({ hasCompletedClaudeInChromeOnboarding: true, claudeInChromeDefaultEnabled: false });

    mkdirSync(path.join(home, '.claude'));
    writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
    run('claude-seed.mjs', home);
    expect(json(path.join(home, '.claude.json')).hasCompletedOnboarding).toBe(true);
  });

  it('approves the API key Emberline injects (by its last 20 characters)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    const key = 'sk-ant-api03-0123456789abcdefghijKLMNOPQRSTUVWXYZ';
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ customApiKeyResponses: { approved: [], rejected: [key.slice(-20)] } }));
    run('claude-seed.mjs', home, { ANTHROPIC_API_KEY: key });
    expect(json(path.join(home, '.claude.json'))).toMatchObject({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    });
  });

  it('keeps a Claude in Chrome answer the user already gave', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    run('claude-seed.mjs', home);
    expect(json(path.join(home, '.claude.json'))).toMatchObject({
      claudeInChromeDefaultEnabled: true,
      hasCompletedClaudeInChromeOnboarding: true,
    });
  });

  it('leaves a file it cannot parse untouched', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    writeFileSync(path.join(home, '.claude.json'), '{ half written');
    run('claude-seed.mjs', home);
    expect(readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{ half written');
  });
});

describe('emberline-cli-seed', () => {
  it('gemini: no update offers, API-key auth preselected, user choices kept', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    mkdirSync(path.join(home, '.gemini'));
    writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ general: { enableAutoUpdate: true }, ui: { theme: 'x' } }));
    run('emberline-cli-seed.mjs', home, { GEMINI_API_KEY: 'k' }, ['gemini']);
    expect(json(path.join(home, '.gemini', 'settings.json'))).toEqual({
      general: { enableAutoUpdate: true, enableAutoUpdateNotification: false },
      ui: { theme: 'x' },
      security: { auth: { selectedType: 'gemini-api-key' } },
    });
  });

  it('copilot: trusts /workspaces and keeps the leading comments of its config file', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    mkdirSync(path.join(home, '.copilot'));
    const file = path.join(home, '.copilot', 'config.json');
    writeFileSync(file, '// managed by copilot\n{ "trustedFolders": ["/home/node/x"] }\n');
    run('emberline-cli-seed.mjs', home, {}, ['copilot']);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('// managed by copilot\n')).toBe(true);
    expect(JSON.parse(text.split('\n').slice(1).join('\n')).trustedFolders).toEqual(['/home/node/x', '/workspaces']);
    expect(json(path.join(home, '.copilot', 'settings.json'))).toEqual({ banner: 'never', showTipsOnStartup: false, autoUpdate: false });
  });

  it('antigravity: trusts the run worktree and forgets worktrees that are gone', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    const worktree = mkdtempSync(path.join(tmpdir(), 'wt-'));
    mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    writeFileSync(file, JSON.stringify({ trustedWorkspaces: ['/workspaces', '/workspaces/.worktrees/gone/1234'], theme: 'x' }));
    const res = spawnSync(process.execPath, [path.join(wrappers, 'emberline-cli-seed.mjs'), 'antigravity'], {
      cwd: worktree,
      env: { PATH: process.env.PATH ?? '', HOME: home },
    });
    expect(res.status).toBe(0);
    expect(json(file)).toEqual({ trustedWorkspaces: ['/workspaces', worktree], theme: 'x' });
  });

  it('sets agy AI credits from the run route and leaves them alone without the env var', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ trustedWorkspaces: [], useG1Credits: true, other: 1 }));
    run('emberline-cli-seed.mjs', home, { EMBERLINE_USE_CREDITS: '0' }, ['antigravity']);
    expect(json(file)).toMatchObject({ useG1Credits: false, other: 1 });
    run('emberline-cli-seed.mjs', home, { EMBERLINE_USE_CREDITS: '1' }, ['antigravity']);
    expect(json(file).useG1Credits).toBe(true);
    run('emberline-cli-seed.mjs', home, {}, ['antigravity']);
    expect(json(file).useG1Credits).toBe(true);
  });

  it('does nothing for agents without first-run config', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    run('emberline-cli-seed.mjs', home, {}, ['codex']);
    expect(existsSync(path.join(home, '.gemini'))).toBe(false);
  });
});

describe('claude-statusline', () => {
  function statusline(home: string, input: string) {
    const res = spawnSync(process.execPath, [path.join(wrappers, 'claude-statusline.mjs')], {
      env: { PATH: process.env.PATH ?? '', HOME: home },
      input,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    return res.stdout;
  }
  const limitsFile = (home: string) => path.join(home, '.claude', 'emberline-rate-limits.json');

  it('keeps the CLI-reported limits in the usage telemetry shape and prints them', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'statusline-'));
    const out = statusline(
      home,
      JSON.stringify({
        model: { id: 'claude-opus-5-5' },
        rate_limits: {
          five_hour: { used_percentage: 42.4, resets_at: 1792171200 },
          seven_day: { used_percentage: 18, resets_at: '2026-10-20T08:00:00Z' },
          spend_limit: { used_percentage: 12.5, used_usd: 2.5, limit_usd: 20, resets_at: 1792171200 },
        },
      }),
    );
    expect(out).toBe('5h 42% · 7d 18% · spend $2.50\n');
    const saved = json(limitsFile(home));
    expect(saved).toMatchObject({
      fiveHour: { utilizationPercent: 42.4, resetsAt: new Date(1792171200 * 1000).toISOString(), severity: 'normal' },
      sevenDay: { utilizationPercent: 18, resetsAt: '2026-10-20T08:00:00.000Z', severity: 'normal' },
      extraUsage: { enabled: true, usedUsd: 2.5, limitUsd: 20, utilizationPercent: 12.5, disabledReason: null },
    });
    expect(typeof saved.updatedAt).toBe('string');
  });

  it('writes nothing without rate limits (API key login) or on bad input', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'statusline-'));
    expect(statusline(home, JSON.stringify({ model: { id: 'claude-opus-5-5' } }))).toBe('\n');
    expect(statusline(home, 'not json')).toBe('\n');
    expect(existsSync(limitsFile(home))).toBe(false);
  });

  it('records only the windows the CLI reports', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'statusline-'));
    expect(statusline(home, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 130 } } }))).toBe('7d 100%\n');
    expect(json(limitsFile(home))).toMatchObject({ fiveHour: null, sevenDay: { utilizationPercent: 100, resetsAt: null }, extraUsage: null });
  });
});
