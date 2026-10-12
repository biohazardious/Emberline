import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HealthResponse } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('core server', () => {
  it('serves a health check matching the shared contract', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json()).status).toBe('ok');
    await app.close();
  });

  it('serves the web UI with SPA fallback but keeps API 404s as JSON', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<h1>ember</h1>');
    const app = buildServer({}, { webDir });
    try {
      expect((await app.inject({ url: '/' })).body).toContain('ember');
      expect((await app.inject({ url: '/board/42' })).body).toContain('ember');
      const api = await app.inject({ url: '/api/nope' });
      expect(api.statusCode).toBe(404);
      expect(api.json()).toEqual({ error: 'not_found' });
    } finally {
      await app.close();
      rmSync(webDir, { recursive: true, force: true });
    }
  });
});
