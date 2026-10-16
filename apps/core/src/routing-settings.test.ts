import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coerceModelForProvider, selectProviderModelByRank } from '@emberline/protocol';
import { settings } from './db/schema.js';
import {
  getFactorySettings,
  getProviderEnvFromSettings,
  getQuotaPolicy,
  resolveRunRoutes,
  routeUsable,
  updateFactorySettings,
} from './factory/settings.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const storeRaw = (value: object, keys: object = {}) => {
  t.db.insert(settings).values({ key: 'factory.settings', value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  t.db.insert(settings).values({ key: 'factory.providerKeys', value: keys }).onConflictDoUpdate({ target: settings.key, set: { value: keys } }).run();
};

describe('persona routes', () => {
  it('rank 3 on Claude is sonnet', () => {
    expect(selectProviderModelByRank('claude', 3)).toBe('sonnet');
  });

  it('migrates personaAgents/personaModels into one-step chains, keeping today\'s key use', () => {
    storeRaw(
      { enabledProviders: ['claude', 'antigravity'], personaAgents: { ui_ux: 'antigravity', coder: 'claude' }, personaModels: { ui_ux: 'argon', coder: 'opus' }, quotaAutoDowngrade: false },
      { anthropicApiKey: 'sk-ant-test' },
    );
    const cfg = getFactorySettings(t.db);
    expect(cfg.personaRoutes.ui_ux).toEqual([{ agent: 'antigravity', model: 'argon', credential: 'login' }]);
    // A stored Anthropic key is used by Claude runs today, so the migrated route keeps it.
    expect(cfg.personaRoutes.coder).toEqual([{ agent: 'claude', model: 'opus', credential: 'api_key' }]);
    expect(cfg.personaAgents.ui_ux).toBe('antigravity');
    expect(cfg.quotaPolicy).toEqual({ newRuns: 'wait', inFlight: 'wait' });
  });

  it('turns quotaAutoDowngrade into a second Claude route', () => {
    storeRaw({ personaModels: { coder: 'opus' }, quotaAutoDowngrade: true });
    expect(getFactorySettings(t.db).personaRoutes.coder).toEqual([
      { agent: 'claude', model: 'opus', credential: 'login' },
      { agent: 'claude', model: 'sonnet', credential: 'login' },
    ]);
  });

  it('normalizes saved chains: disabled providers dropped, credentials coerced, duplicates removed, max 4', () => {
    updateFactorySettings(t.db, { enabledProviders: ['claude', 'antigravity'], antigravityTermsAcknowledged: true });
    const saved = updateFactorySettings(t.db, {
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'api_key' },
          { agent: 'gemini', model: 'gemini-pro', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'login' },
        ],
      },
      quotaPolicy: { inFlight: 'fallback' },
    });
    expect(saved.personaRoutes.ui_ux).toEqual([
      { agent: 'antigravity', model: 'argon', credential: 'login' },
      { agent: 'claude', model: 'opus', credential: 'login' },
    ]);
    expect(saved.quotaPolicy).toEqual({ newRuns: 'wait', inFlight: 'fallback' });
  });

  it('keeps an Antigravity credits route and a Claude api_key route without a stored key', () => {
    updateFactorySettings(t.db, { enabledProviders: ['claude', 'antigravity'], antigravityTermsAcknowledged: true });
    const saved = updateFactorySettings(t.db, {
      personaRoutes: {
        coder: [
          { agent: 'antigravity', model: 'argon', credential: 'credits' },
          { agent: 'claude', model: 'opus', credential: 'api_key' },
        ],
      },
    });
    expect(saved.personaRoutes.coder).toEqual([
      { agent: 'antigravity', model: 'argon', credential: 'credits' },
      { agent: 'claude', model: 'opus', credential: 'api_key' },
    ]);
  });

  it('a legacy personaAgents PATCH rewrites route 0 and keeps the fallbacks', () => {
    updateFactorySettings(t.db, {
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
      personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'login' }, { agent: 'claude', model: 'haiku', credential: 'login' }] },
    });
    const saved = updateFactorySettings(t.db, { personaAgents: { qa: 'antigravity' } });
    expect(saved.personaRoutes.qa[0]?.agent).toBe('antigravity');
    expect(saved.personaRoutes.qa[1]).toEqual({ agent: 'claude', model: 'haiku', credential: 'login' });
  });

  it('builds a run chain from a ticket tag followed by the persona chain', () => {
    updateFactorySettings(t.db, {
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
      personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'login' }, { agent: 'claude', model: 'opus', credential: 'login' }] },
    });
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'claude', model: 'sonnet' })).toEqual([
      { agent: 'claude', model: 'sonnet', credential: 'login' },
      { agent: 'antigravity', model: 'argon', credential: 'login' },
      { agent: 'claude', model: 'opus', credential: 'login' },
    ]);
    expect(resolveRunRoutes(t.db, 'ui_ux')).toHaveLength(2);
  });

  it('a tag with Model: auto takes the model of a same-agent chain step, else the persona model for that agent', () => {
    updateFactorySettings(t.db, {
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
      personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'login' }, { agent: 'claude', model: 'opus', credential: 'login' }] },
    });
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'claude', model: 'auto' })[0]).toEqual({ agent: 'claude', model: 'opus', credential: 'login' });
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'antigravity' })[0]?.model).toBe('argon');
    updateFactorySettings(t.db, { personaRoutes: { ui_ux: [{ agent: 'claude', model: 'sonnet', credential: 'login' }] } });
    const head = resolveRunRoutes(t.db, 'ui_ux', { agent: 'antigravity', model: 'auto' })[0];
    expect(head?.agent).toBe('antigravity');
    expect(head?.model).toBe(coerceModelForProvider('antigravity', 'sonnet', 'ui_ux'));
    expect(head?.model).not.toBe('auto');
  });

  it('a persona whose legacy agent was disabled falls back to api_key when the default agent has a stored key', () => {
    storeRaw(
      { enabledProviders: ['claude'], personaAgents: { ui_ux: 'antigravity' }, personaModels: { ui_ux: 'argon' } },
      { anthropicApiKey: 'sk-ant-test' },
    );
    expect(getFactorySettings(t.db).personaRoutes.ui_ux).toEqual([
      { agent: 'claude', model: 'opus', credential: 'api_key' },
    ]);
  });

  it('a tagged route takes its credential from a same-agent chain step, else the stored key', () => {
    storeRaw(
      {
        enabledProviders: ['claude', 'antigravity'],
        personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'login' }] },
      },
      { anthropicApiKey: 'sk-ant-test' },
    );
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'claude', model: 'sonnet' })[0]).toEqual({
      agent: 'claude',
      model: 'sonnet',
      credential: 'api_key',
    });
    storeRaw({
      enabledProviders: ['claude', 'antigravity'],
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'login' },
        ],
      },
    });
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'claude', model: 'sonnet' })[0]?.credential).toBe('login');
  });

  it('reads the quota policy on its own, with defaults', () => {
    expect(getQuotaPolicy(t.db)).toEqual({ newRuns: 'wait', inFlight: 'wait' });
    updateFactorySettings(t.db, { quotaPolicy: { inFlight: 'fallback' } });
    expect(getQuotaPolicy(t.db)).toEqual({ newRuns: 'wait', inFlight: 'fallback' });
    expect(getQuotaPolicy(t.db)).toEqual(getFactorySettings(t.db).quotaPolicy);
  });

  it('puts provider keys into the env only for api_key routes', () => {
    updateFactorySettings(t.db, { anthropicApiKey: 'sk-ant-test' });
    expect(getProviderEnvFromSettings(t.db, 'claude', 'login')).toEqual({});
    expect(getProviderEnvFromSettings(t.db, 'antigravity', 'credits')).toEqual({});
    expect(getProviderEnvFromSettings(t.db, 'claude', 'api_key')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  });

  it('settings report a key as stored only when saved, not when it comes from the environment', () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-only';
    try {
      let cfg = getFactorySettings(t.db);
      expect(cfg.openaiKeyConfigured).toBe(true);
      expect(cfg.openaiKeyStored).toBe(false);
      updateFactorySettings(t.db, { anthropicApiKey: 'k' });
      cfg = getFactorySettings(t.db);
      expect(cfg.anthropicKeyStored).toBe(true);
      expect(cfg.openaiKeyStored).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it('an api_key route is usable only while its key is stored', () => {
    const route = { agent: 'claude', model: 'opus', credential: 'api_key' } as const;
    expect(routeUsable(t.db, route)).toBe(false);
    updateFactorySettings(t.db, { anthropicApiKey: 'k' });
    expect(routeUsable(t.db, route)).toBe(true);
    expect(routeUsable(t.db, { agent: 'claude', model: 'opus', credential: 'login' })).toBe(true);
    expect(routeUsable(t.db, { agent: 'antigravity', model: 'argon', credential: 'credits' })).toBe(true);
  });
});

describe('maxParallelTicketsPerProject over HTTP', () => {
  it('round-trips 1..4 and rejects 0 and 5 with 400, keeping the stored value', async () => {
    const cookie = await setupAndLogin(t.app);
    const patch = (value: number) =>
      t.app.inject({
        method: 'PATCH',
        url: '/api/factory/settings',
        payload: { maxParallelTicketsPerProject: value },
        headers: { ...CSRF, cookie },
      });
    const read = async () =>
      (await t.app.inject({ method: 'GET', url: '/api/factory/settings', headers: { ...CSRF, cookie } })).json()
        .maxParallelTicketsPerProject;
    expect(await read()).toBe(2);
    for (const value of [1, 2, 3, 4]) {
      const res = await patch(value);
      expect(res.statusCode).toBe(200);
      expect(res.json().maxParallelTicketsPerProject).toBe(value);
      expect(await read()).toBe(value);
    }
    for (const value of [0, 5]) {
      expect((await patch(value)).statusCode).toBe(400);
      expect(await read()).toBe(4);
    }
  });
});

describe('Antigravity terms acknowledgement', () => {
  it('enabling Antigravity requires the acknowledgement; already enabled installs keep running', async () => {
    const cookie = await setupAndLogin(t.app);
    const patch = (payload: object) =>
      t.app.inject({ method: 'PATCH', url: '/api/factory/settings', payload, headers: { ...CSRF, cookie } });

    expect(getFactorySettings(t.db).antigravityTermsAcknowledged).toBe(false);
    const refused = await patch({ enabledProviders: ['claude', 'antigravity'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'antigravity_terms' });
    expect(getFactorySettings(t.db).enabledProviders).toEqual(['claude']);

    const login = await t.app.inject({
      method: 'POST',
      url: '/api/factory/provider-login',
      payload: { provider: 'antigravity' },
      headers: { ...CSRF, cookie },
    });
    expect(login.statusCode).toBe(409);
    expect(getFactorySettings(t.db).enabledProviders).toEqual(['claude']);

    const ok = await patch({ enabledProviders: ['claude', 'antigravity'], antigravityTermsAcknowledged: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ enabledProviders: ['claude', 'antigravity'], antigravityTermsAcknowledged: true });
  });

  it('a pre-existing Antigravity setup without the acknowledgement is not switched off', () => {
    storeRaw({ enabledProviders: ['claude', 'antigravity'] });
    const cfg = updateFactorySettings(t.db, { autoPickupReady: false });
    expect(cfg.enabledProviders).toEqual(['claude', 'antigravity']);
    expect(cfg.antigravityTermsAcknowledged).toBe(false);
  });
});
