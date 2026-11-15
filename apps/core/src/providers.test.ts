import { describe, expect, it } from 'vitest';
import { AgentId } from '@emberline/protocol';
import { type ProviderLaunchContext, providerAdapter, providerIds } from './runs/providers.js';

const ctx = (overrides: Partial<ProviderLaunchContext> = {}): ProviderLaunchContext => ({
  runId: 'run-1',
  hookToken: 'tok',
  coreUrl: 'http://core:7420',
  permissionMode: 'auto',
  model: 'auto',
  prompt: 'do it',
  extraEnv: {},
  claude: { playwrightMcp: false },
  ...overrides,
});

describe('provider adapters', () => {
  it('registers an adapter for every AgentId, under its own id', () => {
    expect(providerIds().sort()).toEqual([...AgentId.options].sort());
    for (const id of providerIds()) expect(providerAdapter(id).id).toBe(id);
    expect(providerAdapter('codex')).toMatchObject({
      displayName: 'Codex',
      hooks: 'wrapper',
      completionSignal: 'exit',
    });
    expect(providerAdapter('claude')).toMatchObject({
      displayName: 'Claude',
      hooks: 'native',
      completionSignal: 'tool',
    });
  });

  it('falls back to Claude for unknown agent ids, and Gemini CLI is one of them now', () => {
    expect(providerAdapter('made-up').id).toBe('claude');
    expect(providerIds()).not.toContain('gemini');
    expect(providerAdapter('gemini').id).toBe('claude');
  });

  it('builds Claude launches with hooks and secondary launches through the wrapper script', () => {
    const claude = providerAdapter('claude').launch(
      ctx({ claude: { command: 'claude', playwrightMcp: false } }),
    );
    expect(claude.args).toContain('--settings');
    expect(claude.env.EMBERLINE_RUN_ID).toBe('run-1');

    const codex = providerAdapter('codex').launch(ctx());
    expect(codex.file).toBe('sh');
    expect(codex.env).toMatchObject({ EMBERLINE_RUN_ID: 'run-1', EMBERLINE_AUTO_APPROVE: '1' });
    expect(
      providerAdapter('codex').launch(ctx({ permissionMode: 'acceptEdits' })).env.EMBERLINE_AUTO_APPROVE,
    ).toBe('0');
    // Core hands each adapter the CLI's own id; the adapter passes it as it is.
    expect(providerAdapter('codex').launch(ctx({ model: 'gpt-6.1-sol' })).args[1]).toContain('gpt-6.1-sol');
  });

  it('routes limit detection to the CLI that printed it', () => {
    const now = new Date('2026-10-13T09:30:00Z');
    const codexLimit = {
      error: 'cli_exit',
      message: "ERROR: You've hit your usage limit. Try again at 3:42 PM.",
    };
    expect(providerAdapter('codex').rateLimitFromHook('StopFailure', codexLimit, { now })?.resetsAt).toEqual(
      new Date('2026-10-13T15:42:00Z'),
    );
    // Claude's own banner on its own lane, with its model pool.
    expect(
      providerAdapter('claude').rateLimitFromHook(
        'StopFailure',
        { error: 'rate_limit', last_assistant_message: 'Opus weekly limit reached ∙ resets 2pm (UTC)' },
        { now, model: 'opus' },
      ),
    ).toMatchObject({ pool: 'opus', resetsAt: new Date('2026-10-13T14:00:00Z') });
  });

  it('asks each adapter whether a headless prompt can run in an asking mode', () => {
    expect(providerAdapter('copilot').headlessProblem('default', true)).toContain('Copilot');
    expect(providerAdapter('copilot').headlessProblem('acceptEdits', true)).toContain('Copilot');
    expect(providerAdapter('codex').headlessProblem('default', true)).toBeNull();
    expect(providerAdapter('claude').headlessProblem('default', true)).toBeNull();
  });
});
