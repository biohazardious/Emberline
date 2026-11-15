import type { FactorySettings, PersonaRouteMap, Route, Run } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { answerErrorText } from './answerDialog';
import { formatAgentDisplayName, formatAgentResumePlaceholder } from './components/RunInspector';
import { buildPresetRoutes } from './components/settings/settingsMeta';
import { handoffCandidates } from './handoffCandidates';
import { recoverErrorText } from './holdRecovery';

// Gemini CLI is no longer a provider; old runs keep `agent: 'gemini'` as a plain string.
const geminiRun = {
  agent: 'gemini',
  model: 'gemini-pro',
  credential: 'api_key',
  routes: [
    { agent: 'gemini', model: 'gemini-pro', credential: 'api_key' },
    { agent: 'claude', model: 'opus', credential: 'login' },
  ],
  routeIndex: 0,
  persona: 'coder',
} as unknown as Run;

describe('an old Gemini CLI run', () => {
  it('is labelled as removed, not as Claude', () => {
    expect(formatAgentDisplayName('gemini')).toBe('Gemini CLI (removed)');
    expect(formatAgentResumePlaceholder('gemini')).toBe(
      'Gemini CLI is no longer supported. Hand this run off to another agent.',
    );
  });

  it("words core's agent_removed refusal of a recover or an answer exactly", () => {
    const copy = 'Gemini CLI is no longer supported. Hand this run off to another agent.';
    expect(recoverErrorText('agent_removed', '')).toBe(copy);
    expect(recoverErrorText('agent_removed', copy)).toBe(copy);
    expect(answerErrorText('agent_removed', copy)).toBe(copy);
  });

  it('offers handoffs to the routes that still exist, never back to Gemini', () => {
    const settings = {
      personaRoutes: { coder: [{ agent: 'claude', model: 'sonnet', credential: 'login' }] },
      enabledProviders: ['claude'],
      anthropicKeyStored: false,
      openaiKeyStored: false,
      geminiKeyStored: true,
    } as unknown as Parameters<typeof handoffCandidates>[1];
    const agents = handoffCandidates(geminiRun, settings).map((c) => c.route.agent);
    expect(agents).not.toContain('gemini');
    expect(agents).toContain('claude');
  });
});

describe('the multi-provider preset', () => {
  const claude = (model: string): Route[] => [{ agent: 'claude', model, credential: 'login' }];
  const routes = {
    product_owner: claude('fable'),
    architect: claude('fable'),
    ui_ux: claude('opus'),
    coder: claude('opus'),
    dba: claude('opus'),
    qa: claude('sonnet'),
    security: claude('opus'),
  } as PersonaRouteMap;

  it('gives UI/UX and QA to Antigravity once it is enabled and acknowledged', () => {
    const { routes: next, notice } = buildPresetRoutes(
      'multi-provider',
      routes,
      ['claude', 'antigravity'],
      'claude',
      true,
    );
    expect(next.ui_ux[0]?.agent).toBe('antigravity');
    expect(next.qa[0]?.agent).toBe('antigravity');
    expect(notice).toContain('Fallbacks were reset. Click Save to persist.');
  });

  it('leaves UI/UX and QA on their routes while Antigravity is not ready', () => {
    for (const [enabled, ack] of [
      [['claude'], true],
      [['claude', 'antigravity'], false],
    ] as [FactorySettings['enabledProviders'], boolean][]) {
      const { routes: next, notice } = buildPresetRoutes('multi-provider', routes, enabled, 'claude', ack);
      expect(next.ui_ux).toEqual(routes.ui_ux);
      expect(next.qa).toEqual(routes.qa);
      expect(notice).toContain(
        'Fallbacks were reset, except UI/UX and QA, which kept their routes: Antigravity is not enabled with its terms acknowledged.',
      );
    }
  });

  it('still sends QA to Codex when Codex is enabled and Antigravity is not', () => {
    const { routes: next, notice } = buildPresetRoutes(
      'multi-provider',
      routes,
      ['claude', 'codex'],
      'claude',
    );
    expect(next.qa[0]?.agent).toBe('codex');
    expect(next.ui_ux).toEqual(routes.ui_ux);
    expect(notice).toContain('Fallbacks were reset, except UI/UX, which kept its route:');
  });
});
