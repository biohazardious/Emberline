import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PRESENCE_TTL_MS, PresenceRegistry } from './notifications/presence.js';
import { createTestApp, setupAndLogin, type TestApp, wsProtocols } from './test-utils.js';

describe('PresenceRegistry', () => {
  it('counts only a visible client that has exactly this run open', () => {
    const registry = new PresenceRegistry();
    const a = Symbol('a');
    registry.set(a, { visible: true, runId: 'r1' });
    expect(registry.isWatched('r1')).toBe(true);
    expect(registry.isWatched('r2')).toBe(false);
    registry.set(a, { visible: false, runId: 'r1' });
    expect(registry.isWatched('r1')).toBe(false);
    registry.set(a, { visible: true, runId: null });
    expect(registry.isWatched('r1')).toBe(false);
  });

  it('drops a client after 120 s without a message, and on close', () => {
    let now = 1_000;
    const registry = new PresenceRegistry(() => now);
    const a = Symbol('a');
    const b = Symbol('b');
    registry.set(a, { visible: true, runId: 'r1' });
    registry.set(b, { visible: true, runId: 'r2' });
    now += PRESENCE_TTL_MS - 1;
    expect(registry.isWatched('r1')).toBe(true);
    registry.set(b, { visible: true, runId: 'r2' }); // heartbeat
    now += 2;
    expect(registry.isWatched('r1')).toBe(false);
    expect(registry.isWatched('r2')).toBe(true);
    registry.remove(b);
    expect(registry.isWatched('r2')).toBe(false);
  });
});

describe('presence over the events socket', () => {
  let t: TestApp;
  let cookie: string;
  beforeEach(async () => {
    t = await createTestApp();
    cookie = await setupAndLogin(t.app);
  });
  afterEach(async () => {
    await t.close();
  });

  const open = async () => {
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, wsProtocols(cookie), { headers: { cookie, origin: address } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  };

  it('keeps presence per socket, ignores bad messages without closing, and drops it on close', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'presence', visible: true, runId: 'r1' }));
    await expect.poll(() => t.presence.isWatched('r1')).toBe(true);

    for (const bad of ['not json', '{"type":"presence"}', '{"type":"presence","visible":"yes","runId":"r2"}', '{"type":"presence","visible":true,"runId":7}', '[]']) {
      ws.send(bad);
    }
    ws.send(JSON.stringify({ type: 'presence', visible: true, runId: 'r2' }));
    await expect.poll(() => t.presence.isWatched('r2')).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(t.presence.isWatched('r1')).toBe(false);

    ws.close();
    await expect.poll(() => t.presence.isWatched('r2')).toBe(false);
  });
});

describe('runs over the events socket', () => {
  let t: TestApp;
  let cookie: string;
  beforeEach(async () => {
    t = await createTestApp();
    cookie = await setupAndLogin(t.app);
  });
  afterEach(async () => {
    await t.close();
  });

  it('a failing attention computation neither escapes the emit nor drops the run update', async () => {
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, wsProtocols(cookie), { headers: { cookie, origin: address } });
    const received: { type: string; run?: { id: string } }[] = [];
    ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    (t.runs as unknown as { attentionOf: () => never }).attentionOf = () => {
      throw new Error('database is locked');
    };
    const run = { id: 'r-x', state: 'working' } as never;
    expect(() => t.runs.emit('run', run, false)).not.toThrow();
    await expect.poll(() => received.find((m) => m.type === 'run')?.run?.id).toBe('r-x');
    ws.close();
  });
});
