import { describe, expect, it } from 'vitest';
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
  it('registers every supported CLI with a display name', () => {
    expect(providerIds().sort()).toEqual(['aider', 'antigravity', 'claude', 'codex', 'copilot', 'gemini']);
    expect(providerAdapter('gemini')).toMatchObject({ displayName: 'Gemini', claudeNative: false });
    expect(providerAdapter('claude')).toMatchObject({ displayName: 'Claude', claudeNative: true });
  });

  it('falls back to Claude for unknown agent ids', () => {
    expect(providerAdapter('made-up').id).toBe('claude');
  });

  it('builds Claude launches with hooks and secondary launches through the wrapper script', () => {
    const claude = providerAdapter('claude').launch(ctx({ claude: { command: 'claude', playwrightMcp: false } }));
    expect(claude.args).toContain('--settings');
    expect(claude.env.EMBERLINE_RUN_ID).toBe('run-1');

    const codex = providerAdapter('codex').launch(ctx());
    expect(codex.file).toBe('sh');
    expect(codex.env).toMatchObject({ EMBERLINE_RUN_ID: 'run-1', EMBERLINE_AUTO_APPROVE: '1' });
    expect(providerAdapter('codex').launch(ctx({ permissionMode: 'acceptEdits' })).env.EMBERLINE_AUTO_APPROVE).toBe('0');
  });
});
