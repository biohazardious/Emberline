import type { FactorySettings, NotificationSettingsView, UpdatesResponse } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSetting } from './db/index.js';
import { DemoTokens } from './demo-token.js';
import { getProviderEnvFromSettings } from './factory/settings.js';
import { gitCredentialForRemote } from './forge/account-store.js';
import { authHeaders, createTestApp, seedForgeAccount, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let headers: Record<string, string>;
beforeEach(async () => {
  t = await createTestApp();
  headers = authHeaders(await setupAndLogin(t.app));
});
afterEach(async () => {
  await t.close();
});

const storedRows = () =>
  JSON.stringify([
    t.db.$client.prepare('select * from settings').all(),
    t.db.$client.prepare('select * from forge_accounts').all(),
  ]);

describe('secrets at rest', () => {
  it('every secret written through its real path is sealed in the database and reads back in memory', async () => {
    const factory = await t.app.inject({
      method: 'PATCH',
      url: '/api/factory/settings',
      headers,
      payload: { anthropicApiKey: 'sk-ant-CANARY1' },
    });
    expect(factory.statusCode).toBe(200);

    const notify = await t.app.inject({
      method: 'PATCH',
      url: '/api/notifications',
      headers,
      payload: { enabled: true, provider: 'ntfy', url: 'https://ntfy.sh/x', token: 'CANARY2' },
    });
    expect(notify.statusCode).toBe(200);

    const updates = await t.app.inject({
      method: 'PATCH',
      url: '/api/updates/config',
      headers,
      payload: { githubToken: 'ghp_CANARY3' },
    });
    expect(updates.statusCode).toBe(200);

    const accountId = seedForgeAccount(t.db, {
      provider: 'github',
      serverUrl: 'https://github.com',
      token: 'CANARY4',
    });
    t.forgeFetch.current = async () =>
      new Response(JSON.stringify({ login: 'octo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const account = await t.app.inject({
      method: 'PATCH',
      url: `/api/forge/accounts/${accountId}`,
      headers,
      payload: { token: 'CANARY5' },
    });
    expect(account.statusCode).toBe(200);

    const demoToken = new DemoTokens(t.db).mint({ projectId: 'p1', targetId: 'main' }, 60_000);
    const demoSecret = getSetting<string>(t.db, 'demo.tokenSecret')!;
    expect(demoSecret).toMatch(/^[0-9a-f]{64}$/);

    const current = (await t.app.inject({ url: '/api/factory/settings', headers })).json() as FactorySettings;
    const mcpServers = current.mcpServers.map((m) =>
      m.id === current.mcpServers[0]!.id ? { ...m, env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'CANARY6' } } : m,
    );
    const mcp = await t.app.inject({
      method: 'PATCH',
      url: '/api/factory/settings',
      headers,
      payload: { mcpServers },
    });
    expect(mcp.statusCode).toBe(200);

    const rows = storedRows();
    expect(rows).not.toMatch(/CANARY/);
    expect(rows).not.toContain(demoSecret);
    expect(rows).toContain('enc:v1:');
    expect(rows).toContain('https://ntfy.sh/x');

    // Every reader gets the plaintext in memory.
    expect(getProviderEnvFromSettings(t.db, 'claude').ANTHROPIC_API_KEY).toBe('sk-ant-CANARY1');
    expect(gitCredentialForRemote(t.db, 'https://github.com/o/r.git', {})?.token).toBe('CANARY5');
    expect(getSetting<{ token: string }>(t.db, 'notifications.config')?.token).toBe('CANARY2');
    expect(getSetting<{ githubToken: string }>(t.db, 'updates.config')?.githubToken).toBe('ghp_CANARY3');
    expect(new DemoTokens(t.db).verify(demoToken)).toEqual({ projectId: 'p1', targetId: 'main' });

    // The API is unchanged: secrets stay write-only, MCP env values are shown as before.
    const after = (await t.app.inject({ url: '/api/factory/settings', headers })).json() as FactorySettings;
    expect(after.anthropicKeyConfigured).toBe(true);
    expect(after.mcpServers[0]!.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'CANARY6' });
    const notifyView = (
      await t.app.inject({ url: '/api/notifications', headers })
    ).json() as NotificationSettingsView;
    expect(notifyView.tokenConfigured).toBe(true);
    expect(JSON.stringify(notifyView)).not.toContain('CANARY');
    const updatesView = (await t.app.inject({ url: '/api/updates', headers })).json() as UpdatesResponse;
    expect(updatesView.config.tokenConfigured).toBe(true);

    // A save that does not touch a secret keeps it sealed and readable.
    await t.app.inject({
      method: 'PATCH',
      url: '/api/factory/settings',
      headers,
      payload: { theme: 'light' },
    });
    expect(storedRows()).not.toMatch(/CANARY/);
    expect(getProviderEnvFromSettings(t.db, 'claude').ANTHROPIC_API_KEY).toBe('sk-ant-CANARY1');
  });
});
