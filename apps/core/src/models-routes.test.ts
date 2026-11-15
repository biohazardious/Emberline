import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { authHeaders, createTestApp, setupAndLogin, type TestApp, wsProtocols } from './test-utils.js';

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
});
afterEach(async () => {
  await t.close();
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, signedIn = true) =>
  t.app.inject({
    method,
    url,
    headers: signedIn ? authHeaders(cookie) : { 'x-emberline-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

type Catalog = Record<string, { models: { id: string; source: string }[]; read: unknown }>;

describe('models routes', () => {
  it('require a session', async () => {
    expect((await call('GET', '/api/models', undefined, false)).statusCode).toBe(401);
    expect((await call('POST', '/api/models/refresh', {}, false)).statusCode).toBe(401);
  });

  it('lists a slot for every provider', async () => {
    const res = await call('GET', '/api/models');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json<{ catalog: Catalog }>().catalog).sort()).toEqual(
      ['aider', 'antigravity', 'claude', 'codex', 'copilot'].sort(),
    );
  });

  it('adds a manual id, lists it, and removes it again', async () => {
    const add = await call('POST', '/api/models/copilot/manual', { id: 'gpt-9-preview', label: 'GPT 9' });
    expect(add.statusCode).toBe(200);
    const list = (await call('GET', '/api/models')).json<{ catalog: Catalog }>().catalog;
    expect(list.copilot!.models.map((m) => [m.id, m.source])).toEqual([['gpt-9-preview', 'manual']]);

    const del = await call('DELETE', '/api/models/copilot/manual/gpt-9-preview');
    expect(del.statusCode).toBe(200);
    const after = (await call('GET', '/api/models')).json<{ catalog: Catalog }>().catalog;
    expect(after.copilot!.models).toEqual([]);
  });

  it('refuses a bad id or an unknown provider with 400', async () => {
    expect((await call('POST', '/api/models/copilot/manual', { id: 'bad id; rm' })).statusCode).toBe(400);
    expect((await call('POST', '/api/models/copilot/manual', { id: 'auto' })).statusCode).toBe(400);
    expect((await call('POST', '/api/models/copilot/manual', {})).statusCode).toBe(400);
    expect((await call('POST', '/api/models/nope/manual', { id: 'x1' })).statusCode).toBe(400);
    expect((await call('POST', '/api/models/refresh', { agent: 'nope' })).statusCode).toBe(400);
  });

  it('refuses to add an id that is already in the list with 409', async () => {
    const res = await call('POST', '/api/models/claude/manual', { id: 'opus' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toBe('opus is already in the list.');
  });

  it('removes only models that were typed in', async () => {
    const res = await call('DELETE', '/api/models/claude/manual/claude-opus-5');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toBe('Only models you added can be removed');
  });

  it('refresh answers with the reads, and why each provider was not read', async () => {
    const res = await call('POST', '/api/models/refresh', {});
    expect(res.statusCode).toBe(200);
    // No runner is there to read from.
    expect(res.json()).toEqual({
      reads: {},
      skipped: {
        claude: 'runner_away',
        antigravity: 'runner_away',
        codex: 'runner_away',
        copilot: 'runner_away',
      },
    });
    // Emberline reads no list of aider's.
    expect((await call('POST', '/api/models/refresh', { agent: 'aider' })).json()).toEqual({
      reads: {},
      skipped: { aider: 'no_reader' },
    });
  });

  it('tells the open events sockets when the catalog changes, so the browsers fetch it again', async () => {
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, wsProtocols(cookie), {
      headers: { cookie, origin: address },
    });
    const events: { type: string }[] = [];
    ws.on('message', (raw) => events.push(JSON.parse(String(raw)) as { type: string }));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      expect((await call('POST', '/api/models/copilot/manual', { id: 'gpt-9-preview' })).statusCode).toBe(
        200,
      );
      await expect.poll(() => events.filter((e) => e.type === 'models')).toEqual([{ type: 'models' }]);
    } finally {
      ws.close();
    }
  });
});
