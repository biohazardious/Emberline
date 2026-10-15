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

  it('does nothing for agents without first-run config', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-'));
    run('emberline-cli-seed.mjs', home, {}, ['codex']);
    expect(existsSync(path.join(home, '.gemini'))).toBe(false);
  });
});
