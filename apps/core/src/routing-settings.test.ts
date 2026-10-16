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
import { createTestApp, type TestApp } from './test-utils.js';

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
    updateFactorySettings(t.db, { enabledProviders: ['claude', 'antigravity'] });
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
    updateFactorySettings(t.db, { enabledProviders: ['claude', 'antigravity'] });
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
      personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'login' }, { agent: 'claude', model: 'haiku', credential: 'login' }] },
    });
    const saved = updateFactorySettings(t.db, { personaAgents: { qa: 'antigravity' } });
    expect(saved.personaRoutes.qa[0]?.agent).toBe('antigravity');
    expect(saved.personaRoutes.qa[1]).toEqual({ agent: 'claude', model: 'haiku', credential: 'login' });
  });

  it('builds a run chain from a ticket tag followed by the persona chain', () => {
    updateFactorySettings(t.db, {
      enabledProviders: ['claude', 'antigravity'],
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

  it('an api_key route is usable only while its key is stored', () => {
    const route = { agent: 'claude', model: 'opus', credential: 'api_key' } as const;
    expect(routeUsable(t.db, route)).toBe(false);
    updateFactorySettings(t.db, { anthropicApiKey: 'k' });
    expect(routeUsable(t.db, route)).toBe(true);
    expect(routeUsable(t.db, { agent: 'claude', model: 'opus', credential: 'login' })).toBe(true);
    expect(routeUsable(t.db, { agent: 'antigravity', model: 'argon', credential: 'credits' })).toBe(true);
  });
});
