import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  it('reads subscription limits from the CLI status line, never from the login token', () => {
    const statusLine = { type: 'command', command: 'claude-statusline.mjs', padding: 0 };
    expect(buildHookSettings('emberline-hook')).toMatchObject({ statusLine });
    expect(buildHookSettings('emberline-hook', 5, true)).toMatchObject({ statusLine });
  });

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
    expect(spec.args.slice(2)).toEqual(['--no-chrome', '--append-system-prompt', RUNNER_ENVIRONMENT]);
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
      '--no-chrome',
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
    expect(spec.args[3]).toBe('--mcp-config');
    expect(JSON.parse(spec.args[4] ?? '')).toEqual(buildPlaywrightMcpConfig());
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
      // The mode is always stated (it stops Claude Code's "make auto the default" nudge), with nothing pre-allowed.
      expect(settings.permissions).toEqual({ defaultMode: permissionMode });
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

  it('leaves a turn that failed for another reason than a limit waiting for the user', () => {
    expect(nextStateFromHook('working', 'StopFailure', { error: 'invalid_request', error_details: 'prompt is too long' })).toBe(
      'waiting_input',
    );
  });

  it('treats the end of a live session as done, but keeps a limit wait', () => {
    expect(nextStateFromHook('working', 'SessionEnd', { reason: 'other' })).toBe('done');
    expect(nextStateFromHook('waiting_input', 'SessionEnd', { reason: 'prompt_input_exit' })).toBe('done');
    expect(nextStateFromHook('rate_limited', 'SessionEnd')).toBeUndefined();
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

describe('secondary CLIs start without first-run questions', () => {
  const base = { runId: 'r1234567', hookToken: 't', coreUrl: 'http://core:7420', prompt: 'do it' };
  const script = (spec: { args: string[] }) => spec.args[1] ?? '';

  it('codex: no removed --full-auto, no inner sandbox, no update offer', () => {
    const auto = buildSecondaryCliLaunchSpec({ ...base, agent: 'codex', permissionMode: 'auto' });
    expect(script(auto)).not.toContain('--full-auto');
    expect(script(auto)).toContain('exec -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox');
    const ask = buildSecondaryCliLaunchSpec({ ...base, agent: 'codex', permissionMode: 'default' });
    expect(script(ask)).toContain('-s danger-full-access');
    expect(script(ask)).toContain('export CODEX_API_KEY="$OPENAI_API_KEY"');
  });

  it('gemini and the agy fallback trust the worktree; accept-edits maps to auto_edit', () => {
    const gemini = buildSecondaryCliLaunchSpec({ ...base, agent: 'gemini', permissionMode: 'acceptEdits' });
    expect(gemini.env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
    expect(script(gemini)).toContain('--approval-mode auto_edit');
    expect(buildSecondaryCliLaunchSpec({ ...base, agent: 'antigravity' }).env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
  });

  it('copilot: unattended runs may use every tool and never ask; no auto-update', () => {
    const auto = buildSecondaryCliLaunchSpec({ ...base, agent: 'copilot', permissionMode: 'auto' });
    expect(script(auto)).toContain('--allow-all --no-ask-user -p');
    expect(auto.env.COPILOT_AUTO_UPDATE).toBe('false');
    expect(script(buildSecondaryCliLaunchSpec({ ...base, agent: 'copilot' }))).not.toContain('--allow-all');
  });

  it('aider: first-run questions are switched off', () => {
    const spec = buildSecondaryCliLaunchSpec({ ...base, agent: 'aider' });
    for (const flag of ['--no-gitignore', '--no-show-release-notes', '--no-show-model-warnings', '--no-check-update', '--analytics-disable']) {
      expect(script(spec)).toContain(flag);
    }
  });

  it('the Claude fallback gets the same pre-answered dialogs', () => {
    const spec = buildSecondaryCliLaunchSpec({ ...base, agent: 'copilot' });
    expect(script(spec)).toContain('claude --settings "$EMBERLINE_CLAUDE_SETTINGS" --no-chrome');
    const settings = JSON.parse(spec.env.EMBERLINE_CLAUDE_SETTINGS ?? '{}');
    expect(settings).toMatchObject({ tui: 'default', skipDangerousModePermissionPrompt: true });
    expect(settings).not.toHaveProperty('hooks');
    expect(spec.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe('1');
  });

  /** Runs a launch spec's script in a git repo with a fake CLI that records its arguments. */
  function runWithFake(agent: 'codex' | 'aider', fakeBody: string, prompt?: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-launch-'));
    execFileSync('git', ['init', '-q', dir]);
    const fake = path.join(dir, `fake-${agent}`);
    writeFileSync(fake, `#!/bin/sh\n${fakeBody}\n`, { mode: 0o755 });
    const envKey = agent === 'codex' ? 'EMBERLINE_CODEX_COMMAND' : 'EMBERLINE_AIDER_COMMAND';
    process.env[envKey] = fake;
    try {
      const spec = buildSecondaryCliLaunchSpec({ ...base, agent, prompt });
      const res = spawnSync(spec.file, spec.args, {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: dir, ...spec.env },
        encoding: 'utf8',
        timeout: 15_000,
      });
      return { dir, status: res.status };
    } finally {
      delete process.env[envKey];
    }
  }

  it('codex UI trusts the repository root, quoted for its config syntax', () => {
    const { dir } = runWithFake('codex', 'for a in "$@"; do printf "%s\\n" "$a"; done > "$PWD/args.txt"');
    const args = readFileSync(path.join(dir, 'args.txt'), 'utf8').split('\n');
    expect(args).toContain(`projects."${execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel']).toString().trim()}".trust_level="trusted"`);
    expect(args).toContain('check_for_update_on_startup=false');
  });

  it('an aider run that could not authenticate fails although aider exits 0', () => {
    const { status } = runWithFake('aider', 'echo "The API provider is not able to authenticate you."; exit 0', 'do it');
    expect(status).toBe(1);
  });

  it('reports the end of the output on a failed exit, so a quota error after long output is kept', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-launch-'));
    execFileSync('git', ['init', '-q', dir]);
    const quota =
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 31h43m5s. AGY_ERROR: RESOURCE_EXHAUSTED (code 429)';
    const fake = path.join(dir, 'fake-agy');
    const work = 'agy: step - reading files, editing components and running the build to check the layout still renders';
    writeFileSync(fake, `#!/bin/sh\nfor i in 1 2 3 4 5 6 7 8; do echo "${work} $i"; done\necho "${quota}"\nexit 3\n`, { mode: 0o755 });
    // Records each hook event with its payload instead of posting it to core.
    const hook = path.join(dir, 'fake-hook');
    writeFileSync(hook, `#!/bin/sh\nprintf '%s %s\\n' "$1" "$(cat)" >> "${dir}/hooks.txt"\n`, { mode: 0o755 });
    process.env.EMBERLINE_ANTIGRAVITY_COMMAND = fake;
    try {
      const spec = buildSecondaryCliLaunchSpec({ ...base, agent: 'antigravity', hookCommand: hook });
      const res = spawnSync(spec.file, spec.args, {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: dir, ...spec.env },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(res.status).toBe(3);
    } finally {
      delete process.env.EMBERLINE_ANTIGRAVITY_COMMAND;
    }
    const failure = readFileSync(path.join(dir, 'hooks.txt'), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('StopFailure '));
    const payload = JSON.parse(failure?.slice('StopFailure '.length) ?? '{}');
    expect(payload.message).toContain('Resets in 31h43m5s. AGY_ERROR: RESOURCE_EXHAUSTED (code 429)');
    expect(payload.message.length).toBeLessThanOrEqual(420);
    expect(nextStateFromHook('working', 'StopFailure', payload, { agent: 'antigravity' })).toBe('rate_limited');
  }, 20_000);
});
