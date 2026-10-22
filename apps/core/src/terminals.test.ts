import { existsSync } from 'node:fs';
import path from 'node:path';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { slugify } from './routes/projects.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp, wsProtocols } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  await ptydServer.close();
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

describe('projects', () => {
  it('slugifies names', () => {
    expect(slugify('  My Cool App! ')).toBe('my-cool-app');
    expect(slugify('Çalışma Alanı')).toBe('calisma-alani');
  });

  it('creates a local project directory and lists it', async () => {
    const res = await api('POST', '/api/projects', { name: 'Demo App' });
    expect(res.statusCode).toBe(201);
    const { project, terminalId } = res.json();
    expect(terminalId).toBeNull();
    expect(project.path).toBe(path.join(t.config.workspacesDir, 'demo-app'));
    expect(existsSync(project.path)).toBe(true);

    expect((await api('GET', '/api/projects')).json()).toHaveLength(1);
    const dup = await api('POST', '/api/projects', { name: 'demo app' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('name_taken');
  });

  it('rejects repo URLs that could inject git options', async () => {
    const res = await api('POST', '/api/projects', { name: 'x', repoUrl: '--upload-pack=evil' });
    expect(res.statusCode).toBe(400);
  });
});

describe('terminals', () => {
  it('reports ptyd status', async () => {
    expect((await api('GET', '/api/system')).json()).toMatchObject({ ptyd: 'connected' });
  });

  it('creates, lists and removes terminals', async () => {
    const created = await api('POST', '/api/terminals', { kind: 'shell' });
    expect(created.statusCode).toBe(201);
    const terminal = created.json();
    expect(terminal).toMatchObject({ kind: 'shell', status: 'running', title: 'Shell · workspaces' });

    expect((await api('GET', '/api/terminals')).json().map((x: { id: string }) => x.id)).toContain(
      terminal.id,
    );
    expect((await api('DELETE', `/api/terminals/${terminal.id}`)).statusCode).toBe(200);
    expect((await api('GET', '/api/terminals')).json()).toHaveLength(0);
  });

  it('streams a terminal over WebSocket: snapshot first, then live output', async () => {
    const terminal = (await api('POST', '/api/terminals', { kind: 'shell' })).json();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `${address.replace('http', 'ws')}/api/terminals/${terminal.id}/ws`;

    const ws = new WebSocket(url, wsProtocols(cookie), { headers: { cookie, origin: address } });
    const messages: { type: string; data?: string }[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(JSON.stringify({ type: 'input', data: 'echo ws-$((6*7))\r' }));
    await expect
      .poll(
        () =>
          messages
            .filter((m) => m.type === 'output')
            .map((m) => m.data)
            .join(''),
        { timeout: 5_000 },
      )
      .toContain('ws-42');
    expect(messages[0]?.type).toBe('snapshot');
    ws.close();
  });

  it('rejects unauthenticated and cross-origin WebSocket upgrades', async () => {
    const terminal = (await api('POST', '/api/terminals', { kind: 'shell' })).json();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `${address.replace('http', 'ws')}/api/terminals/${terminal.id}/ws`;

    const statusOf = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, wsProtocols(cookie), { headers });
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('open', () => {
          ws.close();
          resolve(101);
        });
      });

    expect(await statusOf({ origin: address })).toBe(401);
    expect(await statusOf({ cookie, origin: 'https://evil.example' })).toBe(403);
    expect(await statusOf({ cookie })).toBe(403);
  });

  it('returns 503 when the runner is unreachable', async () => {
    await ptydServer.close();
    await expect.poll(() => t.ptyd.status).not.toBe('connected');
    expect((await api('GET', '/api/terminals')).statusCode).toBe(503);
  });
});
