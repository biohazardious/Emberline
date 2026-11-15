import { describe, expect, it } from 'vitest';
import { buildSecondaryCliLaunchSpec } from './secondary.js';

const base = { runId: 'r1234567', hookToken: 't', coreUrl: 'http://core:7420', prompt: 'do it' };
const script = (spec: { args: string[] }) => spec.args[1] ?? '';

describe('secondary CLIs are launched with their own model id', () => {
  it("Antigravity gets agy's id; without one, agy's own default (no invented --model argon)", () => {
    const spec = buildSecondaryCliLaunchSpec({
      ...base,
      agent: 'antigravity',
      model: 'gemini-4-argon-high',
      routeModel: 'argon',
    });
    expect(script(spec)).toContain('agy --model gemini-4-argon-high -p "$EMBERLINE_PROMPT"');
    const unresolved = script(
      buildSecondaryCliLaunchSpec({ ...base, agent: 'antigravity', routeModel: 'argon' }),
    );
    expect(unresolved).toContain('agy -p "$EMBERLINE_PROMPT"');
    expect(unresolved).not.toContain('--model argon');
  });

  it('Copilot gains --model', () => {
    const spec = buildSecondaryCliLaunchSpec({
      ...base,
      agent: 'copilot',
      model: 'gpt-5.4',
      permissionMode: 'auto',
    });
    expect(script(spec)).toContain(
      'copilot --allow-all --no-ask-user --model gpt-5.4 -p "$EMBERLINE_PROMPT"',
    );
    expect(script(buildSecondaryCliLaunchSpec({ ...base, agent: 'copilot' }))).not.toContain(
      'copilot --model',
    );
  });

  it("the Claude fallback folds the route's Emberline id, not the other CLI's id, into a Claude tier", () => {
    const agy = script(
      buildSecondaryCliLaunchSpec({
        ...base,
        agent: 'antigravity',
        model: 'gemini-4-argon-high',
        routeModel: 'argon',
      }),
    );
    expect(agy).toContain('--model sonnet -- "$EMBERLINE_PROMPT"');
    const copilot = script(
      buildSecondaryCliLaunchSpec({
        ...base,
        agent: 'copilot',
        model: 'claude-opus-4.5',
        routeModel: 'opus',
      }),
    );
    expect(copilot).toContain('--model opus -- "$EMBERLINE_PROMPT"');
    const discovered = script(
      buildSecondaryCliLaunchSpec({
        ...base,
        agent: 'antigravity',
        model: 'claude-opus-5-5-high',
        routeModel: 'claude-opus-5-5-high',
      }),
    );
    expect(discovered).toContain('claude --settings');
    expect(discovered).toContain('--model opus -- "$EMBERLINE_PROMPT"');
  });
});
