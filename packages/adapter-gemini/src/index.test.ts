import { describe, expect, it } from 'vitest';
import { buildGeminiLaunchSpec, geminiAdapter } from './index.js';

const base = { runId: 'r1234567', hookToken: 't', coreUrl: 'http://core:7420', prompt: 'do it' };
const script = (spec: { args: string[] }) => spec.args[1] ?? '';

describe('buildGeminiLaunchSpec', () => {
  it('only auto-approves in auto or bypassPermissions mode; accept-edits maps to auto_edit', () => {
    const careful = buildGeminiLaunchSpec({ ...base, permissionMode: 'acceptEdits' });
    expect(script(careful)).not.toContain('--yolo');
    expect(script(careful)).toContain('--approval-mode auto_edit -p "$EMBERLINE_PROMPT"');
    expect(careful.env.EMBERLINE_AUTO_APPROVE).toBe('0');
    const unattended = buildGeminiLaunchSpec({ ...base, permissionMode: 'bypassPermissions' });
    expect(script(unattended)).toContain('--yolo');
    expect(unattended.env.EMBERLINE_AUTO_APPROVE).toBe('1');
  });

  it('trusts the fresh worktree and maps Emberline model ids', () => {
    const spec = buildGeminiLaunchSpec({
      ...base,
      model: 'gemini-flash-lite',
      extraEnv: { GEMINI_API_KEY: 'k' },
    });
    expect(spec.env).toMatchObject({ GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_API_KEY: 'k' });
    expect(script(spec)).toContain('--model gemini-2.5-flash-lite -p');
    expect(script(buildGeminiLaunchSpec({ ...base, model: 'opus' }))).not.toContain('--model');
  });

  it('starts interactively without a prompt and carries no Emberline MCP tooling', () => {
    const spec = buildGeminiLaunchSpec({ ...base, prompt: undefined, command: '/opt/bin/gemini' });
    expect(script(spec)).toContain('/opt/bin/gemini; STATUS=$?');
    expect(JSON.stringify(buildGeminiLaunchSpec(base))).not.toContain('ticket_complete');
    expect(JSON.stringify(buildGeminiLaunchSpec(base))).not.toContain('emberline-mcp');
  });
});

describe('geminiAdapter', () => {
  it('is a wrapped CLI that signals completion by exit code', () => {
    expect(geminiAdapter).toMatchObject({
      id: 'gemini',
      displayName: 'Gemini',
      hooks: 'wrapper',
      completionSignal: 'exit',
    });
  });

  it('refuses asking modes for a headless prompt', () => {
    for (const [mode, label] of [
      ['default', 'Ask'],
      ['acceptEdits', 'Accept edits'],
    ] as const) {
      expect(geminiAdapter.headlessProblem(mode, true)).toBe(
        `Gemini runs without a terminal to answer in, so in ${label} mode it would refuse every command without telling anyone. Start it in Autonomous mode, or pick another agent.`,
      );
    }
    expect(geminiAdapter.headlessProblem(undefined, true)).toContain('in Ask mode');
    for (const mode of ['auto', 'bypassPermissions', 'plan'] as const) {
      expect(geminiAdapter.headlessProblem(mode, true)).toBeNull();
    }
    expect(geminiAdapter.headlessProblem('default', false)).toBeNull();
  });

  it('frames a persona before the task', () => {
    const brief = { roleTitle: 'Staff QA', systemPrompt: 'Test everything.', rules: 'No skips.' };
    expect(geminiAdapter.decoratePrompt('fix it', brief)).toBe(
      '[Role: Staff QA]\nTest everything.\n\nNo skips.\n\n---\nTask:\nfix it',
    );
    expect(geminiAdapter.decoratePrompt('fix it', undefined)).toBe('fix it');
  });
});
