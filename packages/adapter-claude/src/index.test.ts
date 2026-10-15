import { describe, expect, it } from 'vitest';
import {
  buildHookSettings,
  buildLaunchSpec,
  buildPlaywrightMcpConfig,
  buildSecondaryCliLaunchSpec,
  nextStateFromHook,
  RUNNER_ENVIRONMENT,
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

describe('run settings', () => {
  it('pins the classic renderer and keeps prompts and promos out of the PTY', () => {
    const settings = buildHookSettings('emberline-hook');
    // Any tui value also stops the mid-turn "Try the new fullscreen renderer?" dialog.
    expect(settings).toMatchObject({ tui: 'default', spinnerTipsEnabled: false });
    expect(buildHookSettings('emberline-hook', 5, true)).toMatchObject({ tui: 'default' });
    const spec = buildLaunchSpec({ runId: 'r1', hookToken: 't', coreUrl: 'http://core:7420' });
    expect(spec.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe('1');
  });
});

describe('buildLaunchSpec', () => {
  const base = { runId: 'r1', hookToken: 'tok', coreUrl: 'http://core:7420' };

  it('passes hook settings inline and the run identity via env', () => {
    const spec = buildLaunchSpec(base);
    expect(spec.file).toBe('claude');
    expect(spec.args[0]).toBe('--settings');
    expect(JSON.parse(spec.args[1] ?? '')).toEqual(buildHookSettings('emberline-hook'));
    expect(spec.args.slice(2)).toEqual(['--append-system-prompt', RUNNER_ENVIRONMENT]);
    expect(spec.env).toMatchObject({
      EMBERLINE_RUN_ID: 'r1',
      EMBERLINE_HOOK_TOKEN: 'tok',
      EMBERLINE_CORE_URL: 'http://core:7420',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_SANDBOXED: '1',
    });
  });

  it('adds permission mode, resume and a prompt that can never be parsed as a flag', () => {
    const spec = buildLaunchSpec({
      ...base,
      permissionMode: 'acceptEdits',
      resumeSessionId: 'sess-1',
      prompt: '--help me',
    });
    expect(spec.args.slice(2)).toEqual([
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt',
      RUNNER_ENVIRONMENT,
      '--resume',
      'sess-1',
      '--',
      '--help me',
    ]);
  });

  it('wires headless Playwright MCP via --mcp-config when playwrightMcp is enabled', () => {
    const spec = buildLaunchSpec({
      ...base,
      playwrightMcp: true,
    });
    expect(spec.args[2]).toBe('--mcp-config');
    expect(JSON.parse(spec.args[3] ?? '')).toEqual(buildPlaywrightMcpConfig());
  });

  it('enables auto permission mode, pre-allowed tools, and autonomous system prompt in auto mode', () => {
    const spec = buildLaunchSpec({
      ...base,
      permissionMode: 'auto',
      prompt: 'Add score counter',
    });
    const settings = JSON.parse(spec.args[1] ?? '');
    expect(settings.permissions?.defaultMode).toBe('auto');
    expect(settings.permissions?.allow).toContain('Bash');
    expect(settings.permissions?.allow).toContain('Edit');
    expect(spec.args).toContain('--permission-mode');
    expect(spec.args).toContain('auto');
    expect(spec.args).toContain('--append-system-prompt');
    expect(spec.args[spec.args.indexOf('--append-system-prompt') + 1]).toContain(RUNNER_ENVIRONMENT);
  });

  it('tells every Claude run about the runner, even without other system prompts', () => {
    const spec = buildLaunchSpec({ ...base, permissionMode: 'default', prompt: 'Flash the ESP32' });
    const promptIdx = spec.args.indexOf('--append-system-prompt');
    expect(spec.args[promptIdx + 1]).toBe(RUNNER_ENVIRONMENT);
    expect(RUNNER_ENVIRONMENT).toContain('emberline-sdk install');
    expect(RUNNER_ENVIRONMENT).toContain('xvfb-run');
  });

  it.each(['default', 'acceptEdits', 'plan'] as const)(
    'keeps approval prompts in %s mode and still appends skill prompts',
    (permissionMode) => {
      const spec = buildLaunchSpec({
        ...base,
        permissionMode,
        prompt: 'Add score counter',
        extraSystemPrompt: '## ACTIVE SKILL: Modern UI Craft',
      });
      const settings = JSON.parse(spec.args[1] ?? '');
      expect(settings.permissions).toBeUndefined();
      expect(spec.args).not.toContain('auto');
      const modeIdx = spec.args.indexOf('--permission-mode');
      expect(modeIdx === -1 ? 'default' : spec.args[modeIdx + 1]).toBe(permissionMode);
      const promptIdx = spec.args.indexOf('--append-system-prompt');
      expect(spec.args[promptIdx + 1]).toBe(`${RUNNER_ENVIRONMENT}\n\n## ACTIVE SKILL: Modern UI Craft`);
    },
  );

  it('only auto-approves secondary CLIs in auto or bypassPermissions mode', () => {
    const secondary = { runId: 'r1', hookToken: 't', coreUrl: 'http://core:7420', prompt: 'go' };
    const careful = buildSecondaryCliLaunchSpec({ ...secondary, agent: 'gemini', permissionMode: 'acceptEdits' });
    expect(careful.args[1]).not.toContain('--yolo');
    expect(careful.env.EMBERLINE_AUTO_APPROVE).toBe('0');
    const unattended = buildSecondaryCliLaunchSpec({ ...secondary, agent: 'gemini', permissionMode: 'auto' });
    expect(unattended.args[1]).toContain('--yolo');
    expect(unattended.env.EMBERLINE_AUTO_APPROVE).toBe('1');
  });

  it('merges customMcpServers into --mcp-config, pre-allows mcp__<id>__* tools, and appends extraSystemPrompt', () => {
    const spec = buildLaunchSpec({
      ...base,
      permissionMode: 'auto',
      playwrightMcp: true,
      customMcpServers: {
        context7: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
        },
      },
      extraSystemPrompt: '## ACTIVE SKILL: Modern UI Craft',
    });
    const settings = JSON.parse(spec.args[1] ?? '');
    expect(settings.permissions?.allow).toContain('mcp__context7__*');
    expect(settings.permissions?.allow).toContain('mcp__playwright__*');
    const mcpIdx = spec.args.indexOf('--mcp-config');
    expect(mcpIdx).toBeGreaterThan(-1);
    const mcpConfig = JSON.parse(spec.args[mcpIdx + 1] ?? '');
    expect(mcpConfig.mcpServers).toHaveProperty('playwright');
    expect(mcpConfig.mcpServers.context7).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    });
    const sysIdx = spec.args.indexOf('--append-system-prompt');
    expect(sysIdx).toBeGreaterThan(-1);
    expect(spec.args[sysIdx + 1]).toContain('## ACTIVE SKILL: Modern UI Craft');
  });
});

describe('nextStateFromHook', () => {
  it('treats a session that restarted or was cleared mid-run as waiting at its prompt', () => {
    // Claude Code relaunches itself (renderer switch, crash recovery): the turn in flight is gone.
    expect(nextStateFromHook('working', 'SessionStart', { source: 'resume' })).toBe('waiting_input');
    expect(nextStateFromHook('working', 'SessionStart', { source: 'clear' })).toBe('waiting_input');
    // Compaction happens inside a turn, which keeps going.
    expect(nextStateFromHook('working', 'SessionStart', { source: 'compact' })).toBeUndefined();
  });

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
