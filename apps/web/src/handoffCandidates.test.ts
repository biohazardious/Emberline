import type { FactorySettings, Route, Run } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { defaultRouteFor, handoffCandidates } from './handoffCandidates';

type Settings = Parameters<typeof handoffCandidates>[1] & object;

const settings = (patch: Partial<Settings> = {}): Settings => ({
  personaRoutes: {
    ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'login' }],
  } as FactorySettings['personaRoutes'],
  enabledProviders: ['antigravity', 'claude'],
  anthropicKeyStored: false,
  openaiKeyStored: false,
  geminiKeyStored: false,
  ...patch,
});

const agy: Route = { agent: 'antigravity', model: 'argon', credential: 'login' };
const run = (patch: Partial<Run> = {}) =>
  ({
    agent: 'antigravity',
    model: 'argon',
    credential: 'login',
    routes: [agy],
    routeIndex: 0,
    persona: 'ui_ux',
    ...patch,
  }) as Run;

describe('handoffCandidates', () => {
  it('offers a default route per enabled provider for a single-route run', () => {
    const list = handoffCandidates(run(), settings());
    // The run's own provider gets its persona-rank model (another Antigravity model), Claude its own.
    expect(list.map((c) => c.route)).toEqual([
      { agent: 'antigravity', model: 'gemini-pro', credential: 'login' },
      { agent: 'claude', model: 'opus', credential: 'login' },
    ]);
    expect(list.every((c) => c.source === 'provider')).toBe(true);
  });

  it('orders the run chain, then the persona chain, then provider defaults, without duplicates or the current route', () => {
    const sonnet: Route = { agent: 'claude', model: 'sonnet', credential: 'login' };
    const haiku: Route = { agent: 'claude', model: 'haiku', credential: 'login' };
    const opus: Route = { agent: 'claude', model: 'opus', credential: 'login' };
    const list = handoffCandidates(
      run({ routes: [agy, sonnet] }),
      settings({ personaRoutes: { ui_ux: [agy, haiku, sonnet] } as FactorySettings['personaRoutes'] }),
    );
    expect(list.map((c) => [c.source, c.route])).toEqual([
      ['run', sonnet],
      ['persona', haiku],
      ['provider', { agent: 'antigravity', model: 'gemini-pro', credential: 'login' }],
      ['provider', opus],
    ]);
  });

  it('a chainless legacy run (no routes, no model) still gets the providers', () => {
    const list = handoffCandidates(
      run({ agent: 'claude', model: null, credential: 'login', routes: [], persona: 'coder' }),
      settings(),
    );
    expect(list.map((c) => c.route.agent)).toEqual(['antigravity', 'claude']);
  });

  it('uses the saved API key by default, drops API-key routes without a key and never picks AI credits', () => {
    expect(defaultRouteFor(settings({ anthropicKeyStored: true }), 'claude', 'coder')?.credential).toBe(
      'api_key',
    );
    expect(defaultRouteFor(settings(), 'claude', 'coder')?.credential).toBe('login');
    expect(defaultRouteFor(settings(), 'antigravity', 'coder')?.credential).toBe('login');
    expect(defaultRouteFor(settings(), 'aider', 'coder')).toBeUndefined();
    const keyed: Route = { agent: 'claude', model: 'opus', credential: 'api_key' };
    expect(
      handoffCandidates(run({ routes: [agy, keyed] }), settings()).some(
        (c) => c.route.credential === 'api_key',
      ),
    ).toBe(false);
    expect(
      handoffCandidates(run({ routes: [agy, keyed] }), settings({ anthropicKeyStored: true }))[0]?.route,
    ).toEqual(keyed);
  });

  it('an env-only key offers no api_key default; the provider login default is offered', () => {
    const envOnly = { ...settings(), anthropicKeyConfigured: true, anthropicKeyStored: false } as Settings;
    expect(defaultRouteFor(envOnly, 'claude', 'coder')?.credential).toBe('login');
    expect(handoffCandidates(run(), envOnly).some((c) => c.route.credential === 'api_key')).toBe(false);
    expect(
      handoffCandidates(run(), envOnly).some(
        (c) => c.route.agent === 'claude' && c.route.credential === 'login',
      ),
    ).toBe(true);
  });

  it('marks routes whose lane is out of quota', () => {
    const list = handoffCandidates(
      run({ routes: [agy, { agent: 'antigravity', model: 'gemini-pro', credential: 'login' }] }),
      settings(),
      [{ agent: 'antigravity', credential: 'login', pool: '*' }],
    );
    expect(list.map((c) => [c.route.agent, c.exhausted])).toEqual([
      ['antigravity', true],
      ['claude', false],
    ]);
    expect(list[0]?.route.model).toBe('gemini-pro');
  });

  it('offers only the run chain until the settings have loaded', () => {
    expect(handoffCandidates(run(), undefined)).toEqual([]);
  });
});
