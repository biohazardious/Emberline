import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { announceCompletionTool, createEmberlineMcpServer } from './mcp-server.js';

interface Seen {
  url?: string;
  method?: string;
  auth?: string;
  contentType?: string;
  body?: unknown;
}

let core: Server;
let coreUrl: string;
let seen: Seen;
let reply: { status: number; body: unknown };
/** When set, core never answers; `abandoned` records that the caller closed the request. */
let hold: boolean;
let abandoned: boolean;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeEach(async () => {
  seen = {};
  reply = { status: 200, body: { ok: true } };
  hold = false;
  abandoned = false;
  core = createServer((req, res) => {
    void readBody(req).then((raw) => {
      if (hold) {
        seen = { url: req.url };
        res.on('close', () => {
          if (!res.writableEnded) abandoned = true;
        });
        return;
      }
      seen = {
        url: req.url,
        method: req.method,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : undefined,
      };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
  coreUrl = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
});

afterEach(async () => {
  core.closeAllConnections();
  await new Promise<void>((resolve) => core.close(() => resolve()));
});

async function connect(env: Record<string, string | undefined>): Promise<Client> {
  const server = createEmberlineMcpServer(env);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

const text = (r: unknown): string =>
  ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

describe('emberline MCP server', () => {
  const env = () => ({ EMBERLINE_RUN_ID: 'run 1', EMBERLINE_HOOK_TOKEN: 'tok', EMBERLINE_CORE_URL: coreUrl });

  it('lists the ticket_complete and preview tools with their schemas', async () => {
    const client = await connect(env());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['ticket_complete', 'preview']);
    const preview = tools[1]?.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    // No run id or URL among the inputs: the tool only ever acts on its own run.
    expect(Object.keys(preview.properties)).toEqual(['restart']);
    expect(preview.required ?? []).toEqual([]);
    const schema = tools[0]?.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['blockers', 'handoff', 'summary']);
    expect(schema.required).toEqual(['summary']);
  });

  it('posts the signal to core with the bearer token', async () => {
    const client = await connect(env());
    const r = await client.callTool({
      name: 'ticket_complete',
      arguments: { summary: 'Added the board', handoff: 'See src/board.ts' },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('Recorded. Stop now; Emberline runs the checks and merges.');
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/internal/runs/run%201/complete');
    expect(seen.auth).toBe('Bearer tok');
    expect(seen.contentType).toContain('application/json');
    expect(seen.body).toEqual({ summary: 'Added the board', handoff: 'See src/board.ts', blockers: [] });
  });

  it('answers a blocker signal differently', async () => {
    const client = await connect(env());
    const r = await client.callTool({
      name: 'ticket_complete',
      arguments: { summary: 'Stuck', blockers: ['needs an API key'] },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('Recorded the blockers; a person will look at this ticket. Stop now.');
    expect(seen.body).toEqual({ summary: 'Stuck', handoff: '', blockers: ['needs an API key'] });
  });

  it('truncates over-long input to the limits before sending', async () => {
    const client = await connect(env());
    await client.callTool({
      name: 'ticket_complete',
      arguments: {
        summary: 's'.repeat(5000),
        handoff: 'h'.repeat(9000),
        blockers: Array.from({ length: 12 }, () => 'b'.repeat(600)),
      },
    });
    const body = seen.body as { summary: string; handoff: string; blockers: string[] };
    expect(body.summary).toHaveLength(4000);
    expect(body.handoff).toHaveLength(8000);
    expect(body.blockers).toHaveLength(10);
    expect(body.blockers.every((b) => b.length === 500)).toBe(true);
  });

  it.each([
    [401, 'rejected the token'],
    [404, 'does not know this run'],
    [409, 'already ended'],
    [400, 'rejected the signal'],
    [500, 'HTTP 500'],
  ])('maps HTTP %i to a tool error', async (status, fragment) => {
    reply = { status, body: { error: 'nope' } };
    const client = await connect(env());
    const r = await client.callTool({ name: 'ticket_complete', arguments: { summary: 'done' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(fragment);
  });

  it('reports an unreachable core as a tool error', async () => {
    const client = await connect({ ...env(), EMBERLINE_CORE_URL: 'http://127.0.0.1:1' });
    const r = await client.callTool({ name: 'ticket_complete', arguments: { summary: 'done' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Could not reach Emberline');
  });

  it('refuses to run outside Emberline', async () => {
    const client = await connect({});
    const r = await client.callTool({ name: 'ticket_complete', arguments: { summary: 'done' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('not running under Emberline');
  });

  describe('preview', () => {
    it("starts this run's preview through core with the bearer token and returns its URL", async () => {
      reply = { status: 200, body: { status: 'running', url: 'http://docker:4325/', kind: 'compose' } };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(seen.method).toBe('POST');
      expect(seen.url).toBe('/api/internal/runs/run%201/preview');
      expect(seen.auth).toBe('Bearer tok');
      expect(seen.contentType).toContain('application/json');
      expect(seen.body).toEqual({});
      expect(text(r)).toContain(
        "The preview is running (compose). Open http://docker:4325/ in the browser; it serves this run's own work.",
      );
      // The whole answer is there for the agent too.
      expect(text(r)).toContain('"url":"http://docker:4325/"');
    });

    it('a command preview: the dev server may need a few seconds, so retry a refused connection', async () => {
      reply = { status: 200, body: { status: 'running', url: 'http://localhost:4301/', kind: 'command' } };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(text(r)).toContain('Open http://localhost:4301/ in the browser');
      expect(text(r)).toContain('may take a few seconds to listen');
      expect(text(r)).toContain('retry the navigation if the connection is refused');
    });

    it('a cancelled call stops waiting for core', async () => {
      hold = true;
      const client = await connect(env());
      const controller = new AbortController();
      const call = client.callTool({ name: 'preview', arguments: {} }, undefined, {
        signal: controller.signal,
      });
      await expect.poll(() => seen.url).toBe('/api/internal/runs/run%201/preview');
      controller.abort();
      await expect(call).rejects.toThrow();
      // The server's request to core is aborted too, not left waiting for its 6 min timeout.
      await expect.poll(() => abandoned, { timeout: 3_000 }).toBe(true);
    });

    it('passes restart on', async () => {
      reply = { status: 200, body: { status: 'running', url: 'http://localhost:4301/', kind: 'command' } };
      const client = await connect(env());
      await client.callTool({ name: 'preview', arguments: { restart: true } });
      expect(seen.body).toEqual({ restart: true });
    });

    it('unavailable is an answer, not an error: it names the static build when there is one', async () => {
      reply = {
        status: 200,
        body: {
          status: 'unavailable',
          url: 'http://core:7420/api/demo/tok/',
          kind: 'static',
          error:
            'the preview service "site" runs in Docker. The Docker engine is turned off (EMBERLINE_DOCKER_ENGINE=0 in .env). Remove that line and restart to turn it on.',
        },
      };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain('No preview can run: the preview service "site" runs in Docker');
      expect(text(r)).toContain("Open http://core:7420/api/demo/tok/ instead (this run's static build).");
    });

    it('without any URL it says to build the project and open $EMBERLINE_DEMO_URL', async () => {
      reply = {
        status: 200,
        body: { status: 'unavailable', url: null, kind: 'static', error: 'this project has no preview' },
      };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain('Build the project and open $EMBERLINE_DEMO_URL instead.');
    });

    it('a failed preview gives its error and the logs tail', async () => {
      reply = {
        status: 200,
        body: {
          status: 'failed',
          url: null,
          kind: 'static',
          error: 'docker compose up failed (exit 1)',
          logs: 'npm ci exited 1',
        },
      };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain('The preview failed: docker compose up failed (exit 1)');
      expect(text(r)).toContain('npm ci exited 1');
    });

    it('a preview still starting after the wait says to call again', async () => {
      reply = {
        status: 200,
        body: {
          status: 'starting',
          url: null,
          kind: 'static',
          note: 'the container preview is still starting; this is the static build',
        },
      };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain('The preview is still starting');
      expect(text(r)).toContain('call `preview` again');
    });

    it.each([
      [401, 'rejected the token'],
      [404, 'does not know this run'],
      [409, 'already ended'],
      [500, 'HTTP 500'],
    ])('maps HTTP %i to a tool error', async (status, fragment) => {
      reply = { status, body: { error: 'nope' } };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(fragment);
    });

    it('an answer it does not understand is a tool error', async () => {
      reply = { status: 200, body: { ok: true } };
      const client = await connect(env());
      const r = await client.callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('unexpected');
    });

    it('refuses to run outside Emberline and reports an unreachable core', async () => {
      expect(text(await (await connect({})).callTool({ name: 'preview', arguments: {} }))).toBe(
        'not running under Emberline',
      );
      const r = await (
        await connect({ ...env(), EMBERLINE_CORE_URL: 'http://127.0.0.1:1' })
      ).callTool({ name: 'preview', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Could not reach Emberline');
      expect(seen.url).toBeUndefined();
    });
  });

  describe('check-in (announceCompletionTool)', () => {
    it('posts to the completion-tool endpoint with the bearer token and no body', async () => {
      const logs: string[] = [];
      expect(await announceCompletionTool(env(), (m) => logs.push(m))).toBe(true);
      expect(seen.method).toBe('POST');
      expect(seen.url).toBe('/api/internal/runs/run%201/completion-tool');
      expect(seen.auth).toBe('Bearer tok');
      expect(seen.contentType).toBeUndefined();
      expect(seen.body).toBeUndefined();
      expect(logs).toEqual([]);
    });

    it.each([401, 404, 409, 500])('reports HTTP %i to the log and resolves', async (status) => {
      reply = { status, body: { error: 'nope' } };
      const logs: string[] = [];
      expect(await announceCompletionTool(env(), (m) => logs.push(m))).toBe(false);
      expect(logs.join('')).toContain(`HTTP ${status}`);
    });

    it('survives an unreachable core', async () => {
      const logs: string[] = [];
      expect(
        await announceCompletionTool({ ...env(), EMBERLINE_CORE_URL: 'http://127.0.0.1:1' }, (m) =>
          logs.push(m),
        ),
      ).toBe(false);
      expect(logs.join('')).toContain('emberline-mcp: check-in failed');
    });

    it('sends nothing outside Emberline', async () => {
      const logs: string[] = [];
      expect(await announceCompletionTool({}, (m) => logs.push(m))).toBe(false);
      expect(seen.url).toBeUndefined();
      expect(logs).toEqual([]);
    });
  });

  const spawnEntry = (extraEnv: Record<string, string>) => {
    const entry = new URL('./mcp.ts', import.meta.url).pathname;
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const listTools = async () => {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await expect.poll(() => out.join('').includes('ticket_complete'), { timeout: 15_000 }).toBe(true);
    };
    return { child, out, err, listTools };
  };

  it('the entry point checks in on startup', async () => {
    const { child, listTools } = spawnEntry(env());
    try {
      await expect
        .poll(() => seen.url, { timeout: 15_000 })
        .toBe('/api/internal/runs/run%201/completion-tool');
      expect(seen.auth).toBe('Bearer tok');
      await listTools();
    } finally {
      child.kill();
    }
  }, 30_000);

  it('the entry point keeps serving when the check-in fails', async () => {
    reply = { status: 500, body: { error: 'down' } };
    const { child, err, listTools } = spawnEntry(env());
    try {
      await expect.poll(() => err.join(''), { timeout: 15_000 }).toContain('HTTP 500');
      await listTools();
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
    }
  }, 30_000);

  it('speaks MCP over stdio from the built entry point', async () => {
    const entry = new URL('./mcp.ts', import.meta.url).pathname;
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: string[] = [];
    child.stdout.on('data', (d: Buffer) => lines.push(d.toString('utf8')));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (lines.join('').includes('ticket_complete')) {
          clearInterval(t);
          resolve();
        }
      }, 50);
    });
    child.kill();
    expect(lines.join('')).toContain('"name":"emberline"');
  }, 20_000);
});
