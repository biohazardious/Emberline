import { describe, expect, it } from 'vitest';
import {
  buildHookSettings,
  buildLaunchSpec,
  buildPlaywrightMcpConfig,
  nextStateFromHook,
  stateAfterExit,
  WATCHED_HOOKS,
} from './index.js';

describe('buildHookSettings', () => {
  it('wires every watched hook to the hook command', () => {
    const settings = buildHookSettings('/usr/local/bin/emberline-hook');
    expect(Object.keys(settings.hooks).sort()).toEqual([...WATCHED_HOOKS].sort());
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe('/usr/local/bin/emberline-hook Stop');
  });

  it('adds a catch-all matcher only for tool events', () => {
    const settings = buildHookSettings('h');
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('');
    expect(settings.hooks.Stop?.[0]).not.toHaveProperty('matcher');
  });
});

describe('buildLaunchSpec', () => {
  const base = { runId: 'r1', hookToken: 'tok', coreUrl: 'http://core:7420' };

  it('passes hook settings inline and the run identity via env', () => {
    const spec = buildLaunchSpec(base);
    expect(spec.file).toBe('claude');
    expect(spec.args[0]).toBe('--settings');
    expect(JSON.parse(spec.args[1] ?? '')).toEqual(buildHookSettings('emberline-hook'));
    expect(spec.args).toHaveLength(2);
    expect(spec.env).toMatchObject({
      EMBERLINE_RUN_ID: 'r1',
      EMBERLINE_HOOK_TOKEN: 'tok',
      EMBERLINE_CORE_URL: 'http://core:7420',
      DISABLE_AUTOUPDATER: '1',
    });
  });

  it('adds permission mode, resume and a prompt that can never be parsed as a flag', () => {
    const spec = buildLaunchSpec({
      ...base,
      permissionMode: 'acceptEdits',
      resumeSessionId: 'sess-1',
      prompt: '--help me',
    });
    expect(spec.args.slice(2)).toEqual(['--permission-mode', 'acceptEdits', '--resume', 'sess-1', '--', '--help me']);
  });

  it('wires headless Playwright MCP via --mcp-config when playwrightMcp is enabled', () => {
    const spec = buildLaunchSpec({
      ...base,
      playwrightMcp: true,
    });
    expect(spec.args[2]).toBe('--mcp-config');
    expect(JSON.parse(spec.args[3] ?? '')).toEqual(buildPlaywrightMcpConfig());
  });

  it('enables auto permission mode, pre-allowed tools, and autonomous system prompt when autonomous is true', () => {
    const spec = buildLaunchSpec({
      ...base,
      permissionMode: 'acceptEdits',
      autonomous: true,
      prompt: 'Add score counter',
    });
    const settings = JSON.parse(spec.args[1] ?? '');
    expect(settings.permissions?.defaultMode).toBe('auto');
    expect(settings.permissions?.allow).toContain('Bash');
    expect(settings.permissions?.allow).toContain('Edit');
    expect(spec.args).toContain('--permission-mode');
    expect(spec.args).toContain('auto');
    expect(spec.args).toContain('--append-system-prompt');
  });
});

describe('nextStateFromHook', () => {
  it('follows a typical interactive session', () => {
    expect(nextStateFromHook('starting', 'SessionStart')).toBe('waiting_input');
    expect(nextStateFromHook('waiting_input', 'UserPromptSubmit')).toBe('working');
    expect(nextStateFromHook('working', 'PreToolUse')).toBeUndefined();
    expect(nextStateFromHook('working', 'Notification', { notification_type: 'permission_prompt' })).toBe(
      'waiting_input',
    );
    expect(nextStateFromHook('waiting_input', 'PostToolUse')).toBe('working');
    expect(nextStateFromHook('working', 'Stop')).toBe('done');
    expect(nextStateFromHook('done', 'UserPromptSubmit')).toBe('working');
  });

  it('ignores idle reminders once the turn is done, but not permission prompts', () => {
    expect(nextStateFromHook('done', 'Notification', { notification_type: 'idle_prompt' })).toBeUndefined();
    expect(nextStateFromHook('done', 'Notification', { message: 'Claude needs your permission to use Bash' })).toBe(
      'waiting_input',
    );
  });

  it('never leaves failed and ignores a repeated SessionStart', () => {
    expect(nextStateFromHook('failed', 'UserPromptSubmit')).toBeUndefined();
    expect(nextStateFromHook('done', 'SessionStart')).toBeUndefined();
  });
});

describe('stateAfterExit', () => {
  it('maps the exit code unless a final state was already reached', () => {
    expect(stateAfterExit('working', 0)).toBe('done');
    expect(stateAfterExit('working', 1)).toBe('failed');
    expect(stateAfterExit('starting', null)).toBe('failed');
    expect(stateAfterExit('done', 1)).toBe('done');
  });
});
