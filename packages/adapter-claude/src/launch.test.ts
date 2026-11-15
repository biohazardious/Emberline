import { describe, expect, it } from 'vitest';
import { buildLaunchSpec, resolveClaudeCliModelFlag } from './launch.js';

const base = { runId: 'r1', hookToken: 't', coreUrl: 'http://core:7420', permissionMode: 'auto' as const };
const modelFlag = (args: string[]) => {
  const at = args.indexOf('--model');
  return at < 0 ? undefined : args[at + 1];
};

describe('Claude is launched with its own model id', () => {
  it('Fable runs as Fable, with the deep-analysis policy', () => {
    const spec = buildLaunchSpec({ ...base, model: 'fable' });
    expect(modelFlag(spec.args)).toBe('fable');
    expect(spec.args.join(' ')).toContain('FABLE DEEP-ANALYSIS MODE');
  });

  it('a discovered id is passed as it is, one argument', () => {
    const spec = buildLaunchSpec({ ...base, model: 'claude-opus-4-8' });
    expect(modelFlag(spec.args)).toBe('claude-opus-4-8');
    expect(spec.args.join(' ')).not.toContain('FABLE DEEP-ANALYSIS MODE');
    expect(modelFlag(buildLaunchSpec({ ...base, model: 'claude-fable-5' }).args)).toBe('claude-fable-5');
    expect(buildLaunchSpec({ ...base, model: 'claude-fable-5' }).args.join(' ')).toContain(
      'FABLE DEEP-ANALYSIS MODE',
    );
  });

  it('no model, or auto, keeps Claude Code its own default', () => {
    expect(buildLaunchSpec(base).args).not.toContain('--model');
    expect(buildLaunchSpec({ ...base, model: 'auto' }).args).not.toContain('--model');
  });
});

describe('resolveClaudeCliModelFlag (the Claude fallback of a missing secondary CLI)', () => {
  it("keeps Claude's own aliases and folds other providers' ids into a Claude tier", () => {
    expect(resolveClaudeCliModelFlag('fable')).toBe('fable');
    expect(resolveClaudeCliModelFlag('opus')).toBe('opus');
    expect(resolveClaudeCliModelFlag('o3')).toBe('opus');
    expect(resolveClaudeCliModelFlag('argon')).toBe('sonnet');
    expect(resolveClaudeCliModelFlag('gpt-4o-mini')).toBe('haiku');
    expect(resolveClaudeCliModelFlag('auto')).toBeUndefined();
  });

  it('a discovered id that names a Claude family folds into it; anything else has no tier', () => {
    expect(resolveClaudeCliModelFlag('claude-opus-5-5-high')).toBe('opus');
    expect(resolveClaudeCliModelFlag('claude-sonnet-5-5-low')).toBe('sonnet');
    expect(resolveClaudeCliModelFlag('claude-haiku-4.5')).toBe('haiku');
    expect(resolveClaudeCliModelFlag('gemini-4-argon-high')).toBeUndefined();
  });
});
