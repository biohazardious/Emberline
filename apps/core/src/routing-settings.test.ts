import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coerceModelForProvider,
  getModelsForProvider,
  type ProviderModelInfo,
  selectProviderModelByRank,
  setModelCatalog,
} from '@emberline/protocol';
import { RUNNER_BIN } from './command-exec.js';
import { settings } from './db/schema.js';
import {
  getFactorySettings,
  getProviderEnvFromSettings,
  getQuotaPolicy,
  resolveRunRoutes,
  routeUsable,
  updateFactorySettings,
} from './factory/settings.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { rmTemp } from './test-rm.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  setModelCatalog(null);
  await t.close();
});

const storeRaw = (value: object, keys: object = {}) => {
  t.db
    .insert(settings)
    .values({ key: 'factory.settings', value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
  t.db
    .insert(settings)
    .values({ key: 'factory.providerKeys', value: keys })
    .onConflictDoUpdate({ target: settings.key, set: { value: keys } })
    .run();
};

describe('persona routes', () => {
  it('rank 3 on Claude is sonnet', () => {
    expect(selectProviderModelByRank('claude', 3)).toBe('sonnet');
  });

  it("migrates personaAgents/personaModels into one-step chains, keeping today's key use", () => {
    storeRaw(
      {
        enabledProviders: ['claude', 'antigravity'],
        personaAgents: { ui_ux: 'antigravity', coder: 'claude' },
        personaModels: { ui_ux: 'argon', coder: 'opus' },
        quotaAutoDowngrade: false,
      },
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

  it('reads stored providers and a default agent this core does not know without failing', () => {
    storeRaw({ enabledProviders: ['claude', 'bogus'], defaultAgent: 'bogus' });
    const read = getFactorySettings(t.db);
    expect(read.enabledProviders).toEqual(['claude']);
    expect(read.defaultAgent).toBe('claude');
    storeRaw({ enabledProviders: ['bogus'] });
    expect(getFactorySettings(t.db).enabledProviders).toEqual(['claude']);
  });

  it('normalizes saved chains: disabled providers dropped, credentials coerced, duplicates removed, max 4', () => {
    updateFactorySettings(t.db, {
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
    });
    const saved = updateFactorySettings(t.db, {
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'api_key' },
          { agent: 'codex', model: 'o3', credential: 'login' },
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
    updateFactorySettings(t.db, {
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
    });
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
      personaRoutes: {
        qa: [
          { agent: 'claude', model: 'sonnet', credential: 'login' },
          { agent: 'claude', model: 'haiku', credential: 'login' },
        ],
      },
    });
    const saved = updateFactorySettings(t.db, { personaAgents: { qa: 'antigravity' } });
    expect(saved.personaRoutes.qa[0]?.agent).toBe('antigravity');
    expect(saved.personaRoutes.qa[1]).toEqual({ agent: 'claude', model: 'haiku', credential: 'login' });
  });

  it('builds a run chain from a ticket tag followed by the persona chain', () => {
    updateFactorySettings(t.db, {
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'login' },
        ],
      },
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
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'login' },
        ],
      },
    });
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'claude', model: 'auto' })[0]).toEqual({
      agent: 'claude',
      model: 'opus',
      credential: 'login',
    });
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'antigravity' })[0]?.model).toBe('argon');
    updateFactorySettings(t.db, {
      personaRoutes: { ui_ux: [{ agent: 'claude', model: 'sonnet', credential: 'login' }] },
    });
    const head = resolveRunRoutes(t.db, 'ui_ux', { agent: 'antigravity', model: 'auto' })[0];
    expect(head?.agent).toBe('antigravity');
    expect(head?.model).toBe(coerceModelForProvider('antigravity', 'sonnet', 'ui_ux'));
    expect(head?.model).not.toBe('auto');
  });

  it('a persona whose legacy agent was disabled falls back to api_key when the default agent has a stored key', () => {
    storeRaw(
      {
        enabledProviders: ['claude'],
        personaAgents: { ui_ux: 'antigravity' },
        personaModels: { ui_ux: 'argon' },
      },
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
    expect(resolveRunRoutes(t.db, 'ui_ux', { agent: 'claude', model: 'sonnet' })[0]?.credential).toBe(
      'login',
    );
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
    expect(getProviderEnvFromSettings(t.db, 'claude', 'api_key')).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
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
        headers: authHeaders(cookie),
      });
    const read = async () =>
      (
        await t.app.inject({ method: 'GET', url: '/api/factory/settings', headers: authHeaders(cookie) })
      ).json().maxParallelTicketsPerProject;
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

describe('buildOutputsQuotaGb over HTTP', () => {
  it('defaults to 5, round-trips 0.5..1000 and rejects values outside with 400', async () => {
    const cookie = await setupAndLogin(t.app);
    const patch = (value: number) =>
      t.app.inject({
        method: 'PATCH',
        url: '/api/factory/settings',
        payload: { buildOutputsQuotaGb: value },
        headers: authHeaders(cookie),
      });
    const read = async () =>
      (
        await t.app.inject({ method: 'GET', url: '/api/factory/settings', headers: authHeaders(cookie) })
      ).json().buildOutputsQuotaGb;
    expect(await read()).toBe(5);
    for (const value of [0.5, 12.5, 1000]) {
      const res = await patch(value);
      expect(res.statusCode).toBe(200);
      expect(res.json().buildOutputsQuotaGb).toBe(value);
      expect(await read()).toBe(value);
    }
    for (const value of [0.4, 0, -1, 1000.5]) {
      expect((await patch(value)).statusCode).toBe(400);
      expect(await read()).toBe(1000);
    }
  });
});

describe('Antigravity terms acknowledgement', () => {
  it('enabling Antigravity requires the acknowledgement; already enabled installs keep running', async () => {
    const cookie = await setupAndLogin(t.app);
    const patch = (payload: object) =>
      t.app.inject({ method: 'PATCH', url: '/api/factory/settings', payload, headers: authHeaders(cookie) });

    expect(getFactorySettings(t.db).antigravityTermsAcknowledged).toBe(false);
    const refused = await patch({ enabledProviders: ['claude', 'antigravity'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'antigravity_terms' });
    expect(getFactorySettings(t.db).enabledProviders).toEqual(['claude']);

    const login = await t.app.inject({
      method: 'POST',
      url: '/api/factory/provider-login',
      payload: { provider: 'antigravity' },
      headers: authHeaders(cookie),
    });
    expect(login.statusCode).toBe(409);
    expect(getFactorySettings(t.db).enabledProviders).toEqual(['claude']);

    const ok = await patch({
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      enabledProviders: ['claude', 'antigravity'],
      antigravityTermsAcknowledged: true,
    });
  });

  it('a pre-existing Antigravity setup without the acknowledgement is not switched off', () => {
    storeRaw({ enabledProviders: ['claude', 'antigravity'] });
    const cfg = updateFactorySettings(t.db, { autoPickupReady: false });
    expect(cfg.enabledProviders).toEqual(['claude', 'antigravity']);
    expect(cfg.antigravityTermsAcknowledged).toBe(false);
  });
});

describe('the Gemini key after Gemini CLI', () => {
  const withHome = (files: Record<string, string>, fn: () => void) => {
    const home = mkdtempSync(path.join(tmpdir(), 'ember-home-'));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      writeFileSync(path.join(home, rel), body);
    }
    const saved = {
      home: process.env.EMBERLINE_RUNNER_HOME,
      g: process.env.GEMINI_API_KEY,
      k: process.env.GOOGLE_API_KEY,
    };
    process.env.EMBERLINE_RUNNER_HOME = home;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      fn();
    } finally {
      for (const [name, v] of [
        ['EMBERLINE_RUNNER_HOME', saved.home],
        ['GEMINI_API_KEY', saved.g],
        ['GOOGLE_API_KEY', saved.k],
      ] as const) {
        if (v === undefined) delete process.env[name];
        else process.env[name] = v;
      }
      rmTemp(home);
    }
  };

  it('Gemini CLI login files sign in nothing and enable nothing', () => {
    withHome({ '.gemini/oauth_creds.json': '{}' }, () => {
      const cfg = getFactorySettings(t.db);
      expect(Object.keys(cfg.providerAuth!)).not.toContain('gemini');
      expect(cfg.providerAuth!.antigravity.authenticated).toBe(false);
      expect(cfg.enabledProviders).toEqual(['claude']);
    });
  });

  it('a saved Gemini key enables no provider and does not sign in Antigravity; Aider uses it', () => {
    withHome({}, () => {
      const before = getFactorySettings(t.db).enabledProviders;
      const cfg = updateFactorySettings(t.db, { geminiApiKey: 'k' });
      expect(cfg.enabledProviders).toEqual(before);
      expect(cfg.geminiKeyStored).toBe(true);
      expect(cfg.providerAuth!.antigravity).toMatchObject({ authenticated: false, method: 'none' });
      expect(cfg.providerAuth!.aider).toMatchObject({ authenticated: true, method: 'api_key' });
    });
  });

  it('an Antigravity step on the API key runs on its login', () => {
    withHome({}, () => {
      storeRaw(
        {
          enabledProviders: ['claude', 'antigravity'],
          antigravityTermsAcknowledged: true,
          personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'api_key' }] },
        },
        { geminiApiKey: 'k' },
      );
      expect(getFactorySettings(t.db).personaRoutes.ui_ux).toEqual([
        { agent: 'antigravity', model: 'argon', credential: 'login' },
      ]);
    });
  });
});

describe('Claude and Copilot sign-in detection', () => {
  const withHome = (files: Record<string, string>, fn: () => void) => {
    const home = mkdtempSync(path.join(tmpdir(), 'ember-home-'));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      writeFileSync(path.join(home, rel), body);
    }
    const saved = process.env.EMBERLINE_RUNNER_HOME;
    process.env.EMBERLINE_RUNNER_HOME = home;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.EMBERLINE_RUNNER_HOME;
      else process.env.EMBERLINE_RUNNER_HOME = saved;
      rmTemp(home);
    }
  };
  const auth = () => getFactorySettings(t.db).providerAuth!;
  const loggedOutClaude = JSON.stringify({
    claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: null, subscriptionType: 'max' },
  });

  it('a Claude credentials file with emptied tokens and a leftover account is not a login', () => {
    withHome(
      {
        '.claude/.credentials.json': loggedOutClaude,
        '.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' } }),
      },
      () => expect(auth().claude).toMatchObject({ authenticated: false, method: 'none' }),
    );
  });

  it('a Claude credentials file with a token is a login', () => {
    withHome(
      {
        '.claude/.credentials.json': JSON.stringify({
          claudeAiOauth: { accessToken: 'tok', refreshToken: 'r' },
        }),
      },
      () => expect(auth().claude).toMatchObject({ authenticated: true, method: 'oauth_cli' }),
    );
  });

  it('an Anthropic Console login (its key in ~/.claude.json) is a login', () => {
    withHome(
      {
        '.claude.json': JSON.stringify({
          primaryApiKey: 'sk-ant-console',
          oauthAccount: { emailAddress: 'someone@example.com' },
        }),
      },
      () => expect(auth().claude).toMatchObject({ authenticated: true, method: 'oauth_cli' }),
    );
  });

  it('an empty or missing Console key with an emptied credentials file is not a login', () => {
    for (const primaryApiKey of ['', '   ', null, 42]) {
      withHome(
        {
          '.claude/.credentials.json': loggedOutClaude,
          '.claude.json': JSON.stringify({
            primaryApiKey,
            oauthAccount: { emailAddress: 'someone@example.com' },
          }),
        },
        () =>
          expect(auth().claude, String(primaryApiKey)).toMatchObject({
            authenticated: false,
            method: 'none',
          }),
      );
    }
  });

  it('the ~/.copilot folder Copilot creates on its first start is not a login', () => {
    withHome(
      {
        '.copilot/config.json':
          '// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  "firstLaunchAt": "2026-11-15T08:47:14.760Z",\n  "trustedFolders": ["/workspaces"]\n}\n',
      },
      () => expect(auth().copilot.authenticated).toBe(false),
    );
  });

  it("a user recorded in Copilot's config, or a gh CLI token, is a login", () => {
    withHome(
      {
        '.copilot/config.json':
          '// This file is managed automatically.\n{ "loggedInUsers": [{ "host": "https://github.com", "login": "someone" }], "lastLoggedInUser": { "host": "https://github.com", "login": "someone" } }\n',
      },
      () => expect(auth().copilot.authenticated).toBe(true),
    );
    withHome({ '.config/gh/hosts.yml': 'github.com:\n    oauth_token: gho_x\n    user: someone\n' }, () =>
      expect(auth().copilot.authenticated).toBe(true),
    );
  });
});

describe('the provider Login commands', () => {
  it('Codex and Copilot sign in with a device code, not a browser redirect to the runner', async () => {
    const cookie = await setupAndLogin(t.app);
    const spawned: { args: string[] }[] = [];
    vi.spyOn(t.ptyd, 'get').mockReturnValue({
      spawn: async (params: { file: string; args: string[]; meta?: { title?: string } }) => {
        spawned.push(params);
        return { id: 's1', status: 'running', meta: params.meta ?? {} };
      },
    } as never);
    for (const provider of ['codex', 'copilot'] as const) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/factory/provider-login',
        payload: { provider },
        headers: authHeaders(cookie),
      });
      expect(res.statusCode).toBe(201);
    }
    expect(spawned[0]!.args[1]).toContain('; codex login --device-auth;');
    expect(spawned[1]!.args[1]).toContain('; copilot login --device-code;');
  });
});

describe('requireCompletionSignal over HTTP', () => {
  it('defaults to true and round-trips', async () => {
    const cookie = await setupAndLogin(t.app);
    const patch = (value: unknown) =>
      t.app.inject({
        method: 'PATCH',
        url: '/api/factory/settings',
        payload: { requireCompletionSignal: value },
        headers: authHeaders(cookie),
      });
    const read = async () =>
      (
        await t.app.inject({ method: 'GET', url: '/api/factory/settings', headers: authHeaders(cookie) })
      ).json().requireCompletionSignal;
    expect(await read()).toBe(true);
    expect((await patch(false)).json().requireCompletionSignal).toBe(false);
    expect(await read()).toBe(false);
    expect((await patch(true)).json().requireCompletionSignal).toBe(true);
    expect((await patch('no')).statusCode).toBe(400);
  });
});

describe('the provider Login terminal', () => {
  it("is the image's bash by its path, never one planted on the runner's PATH", async () => {
    const cookie = await setupAndLogin(t.app);
    const spawned: { file: string; args: string[] }[] = [];
    vi.spyOn(t.ptyd, 'get').mockReturnValue({
      spawn: async (params: { file: string; args: string[]; meta?: { title?: string } }) => {
        spawned.push(params);
        return { id: 's1', status: 'running', meta: params.meta ?? {} };
      },
    } as never);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/factory/provider-login',
      payload: { provider: 'claude' },
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(201);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.file).toBe(RUNNER_BIN.bash);
    expect(spawned[0]!.args[1]).toMatch(new RegExp(`exec ${RUNNER_BIN.bash} -i$`));
  });
});

describe('a route model the agent lacks, over HTTP', () => {
  const route = (model: string) => ({ coder: [{ agent: 'claude', model, credential: 'login' }] });

  it('is refused with the models the agent knows, and accepted once the catalog has it', async () => {
    const cookie = await setupAndLogin(t.app);
    const patch = (model: string) =>
      t.app.inject({
        method: 'PATCH',
        url: '/api/factory/settings',
        payload: { personaRoutes: route(model) },
        headers: authHeaders(cookie),
      });
    const ids = getModelsForProvider('claude')
      .map((m) => m.id)
      .join(', ');
    const refused = await patch('gemini-4-carbon-high');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe(
      `gemini-4-carbon-high is not a Claude model Emberline knows. Add it in Settings → Providers, or pick one of: ${ids}.`,
    );

    const added: ProviderModelInfo = {
      id: 'gemini-4-carbon-high',
      label: 'Carbon',
      shortLabel: 'carbon',
      rank: 4,
      tier: 'high',
      badge: '',
      capabilities: ['code'],
      description: '',
      source: 'manual',
    };
    setModelCatalog({ claude: [added] } as never);
    const accepted = await patch('gemini-4-carbon-high');
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().personaRoutes.coder[0].model).toBe('gemini-4-carbon-high');
  });
});
