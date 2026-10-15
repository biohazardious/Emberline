import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenedDb, openDb } from './db/index.js';
import { getFactorySettings, updateFactorySettings } from './factory/settings.js';
import { UpdateService } from './updates/service.js';
import { compareVersions, splitPackageSpec } from './updates/versions.js';

describe('compareVersions', () => {
  it('orders numerically, ignores a leading v and ranks releases above their prereleases', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.3', '0.1.3')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('latest', '1.0.0')).toBe(0);
  });

  it('splits scoped and versioned package specs', () => {
    expect(splitPackageSpec('@upstash/context7-mcp')).toEqual({
      name: '@upstash/context7-mcp',
      version: null,
    });
    expect(splitPackageSpec('@scope/pkg@1.2.3')).toEqual({ name: '@scope/pkg', version: '1.2.3' });
    expect(splitPackageSpec('pkg@^2')).toEqual({ name: 'pkg', version: '^2' });
  });
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a URL -> JSON table and records every request. */
function fakeFetch(routes: Record<string, unknown>, calls: Call[]) {
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const body = routes[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
}

const RELEASES = 'https://api.github.com/repos/biohazardious/emberline/releases?per_page=20';

describe('UpdateService', () => {
  let opened: OpenedDb;
  let dir: string;
  let toolsDir: string;
  let runnerHome: string;
  const calls: Call[] = [];

  beforeEach(() => {
    opened = openDb(':memory:');
    dir = mkdtempSync(path.join(tmpdir(), 'updates-'));
    toolsDir = path.join(dir, 'tools');
    runnerHome = path.join(dir, 'home');
    calls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  }

  function service(routes: Record<string, unknown>, version = '0.1.2') {
    return new UpdateService(opened.db, {
      version,
      toolsDir,
      runnerHome,
      fetch: fakeFetch(routes, calls),
    });
  }

  it('reports a newer Emberline release, CLI updates and not-installed CLIs', async () => {
    writeJson(path.join(toolsDir, 'npm/lib/node_modules/@anthropic-ai/claude-code/package.json'), {
      version: '2.0.1',
    });
    const updates = service({
      [RELEASES]: [
        { tag_name: 'v0.2.0', html_url: 'https://example/v0.2.0', body: 'draft', draft: true },
        {
          tag_name: 'v0.1.3',
          html_url: 'https://example/v0.1.3',
          body: '### Added\n- Updates',
          published_at: '2026-10-16',
        },
        { tag_name: 'v0.1.2', html_url: 'https://example/v0.1.2', body: '' },
      ],
      'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest': { version: '2.1.0' },
    });

    const status = await updates.check();

    const emberline = status.items.find((i) => i.id === 'emberline');
    expect(emberline).toMatchObject({ installed: '0.1.2', latest: '0.1.3', state: 'update_available' });
    expect(status.release).toMatchObject({ version: '0.1.3', notes: '### Added\n- Updates' });
    expect(status.items.find((i) => i.id === 'cli:claude')).toMatchObject({
      installed: '2.0.1',
      latest: '2.1.0',
      state: 'update_available',
      provider: 'claude',
    });
    expect(status.items.find((i) => i.id === 'cli:codex')?.state).toBe('not_installed');
    expect(status.available).toBe(2);
    expect(updates.get().status.checkedAt).toBe(status.checkedAt);

    // An update installed after the check shows without another request.
    writeJson(path.join(toolsDir, 'npm/lib/node_modules/@anthropic-ai/claude-code/package.json'), {
      version: '2.1.0',
    });
    const fetched = calls.length;
    const after = updates.get().status;
    expect(after.items.find((i) => i.id === 'cli:claude')).toMatchObject({
      installed: '2.1.0',
      state: 'up_to_date',
    });
    expect(after.available).toBe(1);
    expect(calls).toHaveLength(fetched);
  });

  it('sends the GitHub token to api.github.com only and never returns it', async () => {
    writeJson(path.join(toolsDir, 'npm/lib/node_modules/@anthropic-ai/claude-code/package.json'), {
      version: '2.0.1',
    });
    const updates = service({ [RELEASES]: [] });
    const view = updates.updateConfig({ githubToken: 'ghp_secret' });
    expect(view.config.tokenConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('ghp_secret');

    await updates.check();

    for (const call of calls) {
      const auth = call.headers.Authorization;
      if (new URL(call.url).host === 'api.github.com') expect(auth).toBe('Bearer ghp_secret');
      else expect(auth).toBeUndefined();
    }
    expect(calls.some((c) => c.url.startsWith('https://registry.npmjs.org/'))).toBe(true);

    expect(updates.updateConfig({ githubToken: null }).config.tokenConfigured).toBe(false);
  });

  it('explains a 404 from a private repository without a token', async () => {
    const status = await service({}).check();
    expect(status.items[0]).toMatchObject({ id: 'emberline', state: 'error' });
    expect(status.items[0]?.note).toContain('GitHub token');
  });

  it('sends nothing on its own while automatic checks are off', async () => {
    vi.useFakeTimers();
    const updates = service({ [RELEASES]: [] });
    updates.updateConfig({ autoCheck: false });
    updates.start();
    await vi.advanceTimersByTimeAsync(13 * 60 * 60_000);
    updates.stop();
    expect(calls).toHaveLength(0);

    updates.updateConfig({ autoCheck: true });
    updates.start();
    await vi.advanceTimersByTimeAsync(61_000);
    updates.stop();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('forgets a stored result once Emberline runs a different version', async () => {
    await service({ [RELEASES]: [{ tag_name: 'v0.1.3', html_url: 'u' }] }).check();
    const after = service({}, '0.1.3').get().status;
    expect(after).toMatchObject({ checkedAt: null, currentVersion: '0.1.3', items: [], available: 0 });
  });

  describe('MCP servers run through npx', () => {
    beforeEach(() => {
      const current = getFactorySettings(opened.db).mcpServers;
      updateFactorySettings(opened.db, {
        mcpServers: [
          ...current.map((s) => (s.id === 'context7' ? { ...s, enabled: true } : s)),
          { id: 'pinned', name: 'Pinned', command: 'npx', args: ['-y', 'some-mcp@1.4.0'], enabled: true },
        ],
      });
    });

    it('compares the cached copy with npm and leaves pinned servers alone', async () => {
      const npx = path.join(runnerHome, '.npm/_npx');
      writeJson(path.join(npx, 'a1b2c3/node_modules/@upstash/context7-mcp/package.json'), {
        version: '1.0.0',
      });
      writeJson(path.join(npx, 'not-a-hash/node_modules/@upstash/context7-mcp/package.json'), {
        version: '9.0.0',
      });
      const status = await service({
        [RELEASES]: [],
        'https://registry.npmjs.org/@upstash%2Fcontext7-mcp/latest': { version: '1.2.0' },
      }).check();

      expect(status.items.find((i) => i.id === 'mcp:context7')).toMatchObject({
        installed: '1.0.0',
        latest: '1.2.0',
        state: 'update_available',
        mcpId: 'context7',
      });
      expect(status.items.find((i) => i.id === 'mcp:pinned')).toMatchObject({
        installed: '1.4.0',
        state: 'pinned',
      });
      expect(status.items.some((i) => i.id === 'mcp:playwright')).toBe(false);
      expect(calls.some((c) => c.url.includes('some-mcp'))).toBe(false);
    });

    it('refresh removes only the cache entries of that package', async () => {
      const npx = path.join(runnerHome, '.npm/_npx');
      writeJson(path.join(npx, 'aaaa/node_modules/@upstash/context7-mcp/package.json'), { version: '1.0.0' });
      writeJson(path.join(npx, 'bbbb/node_modules/other-mcp/package.json'), { version: '1.0.0' });
      const updates = service({
        [RELEASES]: [],
        'https://registry.npmjs.org/@upstash%2Fcontext7-mcp/latest': { version: '1.2.0' },
      });

      const result = await updates.refreshMcp('context7');

      expect(existsSync(path.join(npx, 'aaaa'))).toBe(false);
      expect(existsSync(path.join(npx, 'bbbb'))).toBe(true);
      expect(result.status.items.find((i) => i.id === 'mcp:context7')).toMatchObject({
        installed: null,
        state: 'up_to_date',
      });
      await expect(updates.refreshMcp('playwright')).rejects.toMatchObject({ statusCode: 404 });
      await expect(updates.refreshMcp('missing')).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
