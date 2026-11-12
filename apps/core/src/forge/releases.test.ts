import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects } from '../db/schema.js';
import { startFakeForge } from '../test-fake-forge.js';
import { createTestApp, seedForgeAccount, type TestApp } from '../test-utils.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});
const project = (id: string, repoUrl: string) =>
  t.db
    .insert(projects)
    .values({ id, name: id, slug: id, repoUrl, path: `${t.dir}/${id}`, createdAt: new Date() })
    .run();
const input = { tag: 'v1.2.3', name: 'v1.2.3', notes: 'What changed' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
const record = (reply: unknown, status = 201) => {
  const calls: Call[] = [];
  t.forgeFetch.current = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
};

describe('createRelease', () => {
  it('GitHub: posts tag_name, name and body and returns html_url', async () => {
    project('g', 'https://github.com/acme/widget.git');
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'gh-tok' });
    const calls = record({ html_url: 'https://github.com/acme/widget/releases/tag/v1.2.3' });
    expect(await t.forge.createRelease('g', input)).toEqual({
      url: 'https://github.com/acme/widget/releases/tag/v1.2.3',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/acme/widget/releases',
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer gh-tok' }),
        body: { tag_name: 'v1.2.3', name: 'v1.2.3', body: 'What changed' },
      },
    ]);
  });

  it('GitLab: posts description with the encoded project path; url from _links.self, else the releases page', async () => {
    project('l', 'https://gitlab.com/acme/widget.git');
    seedForgeAccount(t.db, { provider: 'gitlab', serverUrl: 'https://gitlab.com', token: 'gl-tok' });
    let calls = record({ _links: { self: 'https://gitlab.com/acme/widget/-/releases/v1.2.3' } });
    expect(await t.forge.createRelease('l', input)).toEqual({
      url: 'https://gitlab.com/acme/widget/-/releases/v1.2.3',
    });
    expect(calls).toEqual([
      {
        url: 'https://gitlab.com/api/v4/projects/acme%2Fwidget/releases',
        method: 'POST',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'gl-tok' }),
        body: { tag_name: 'v1.2.3', name: 'v1.2.3', description: 'What changed' },
      },
    ]);
    calls = record({});
    expect(await t.forge.createRelease('l', input)).toEqual({
      url: 'https://gitlab.com/acme/widget/-/releases/v1.2.3',
    });
    expect(calls).toHaveLength(1);
  });

  it('Gitea: posts tag_name, name and body and returns html_url', async () => {
    project('t', 'https://gitea.example.com/acme/widget.git');
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: 'https://gitea.example.com', token: 'gt-tok' });
    const calls = record({ html_url: 'https://gitea.example.com/acme/widget/releases/tag/v1.2.3' });
    expect(await t.forge.createRelease('t', input)).toEqual({
      url: 'https://gitea.example.com/acme/widget/releases/tag/v1.2.3',
    });
    expect(calls).toEqual([
      {
        url: 'https://gitea.example.com/api/v1/repos/acme/widget/releases',
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'token gt-tok' }),
        body: { tag_name: 'v1.2.3', name: 'v1.2.3', body: 'What changed' },
      },
    ]);
  });

  it('a forge refusal is a forge_error carrying its status and text', async () => {
    project('t', 'https://gitea.example.com/acme/widget.git');
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: 'https://gitea.example.com', token: 'gt-tok' });
    record('tag exists', 409);
    await expect(t.forge.createRelease('t', input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'forge_error',
      message: 'Gitea release failed (409): tag exists',
    });
  });

  it('without a forge account it is a 409 forge_account_missing', async () => {
    project('t', 'https://gitea.example.com/acme/widget.git');
    await expect(t.forge.createRelease('t', input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'forge_account_missing',
    });
  });

  it('against the fake forge the release is recorded', async () => {
    const forge = await startFakeForge({ token: 'ft' });
    try {
      project('f', `${forge.url}/acme/widget.git`);
      seedForgeAccount(t.db, { provider: 'gitea', serverUrl: forge.url, token: 'ft' });
      const out = await t.forge.createRelease('f', input);
      expect(out.url).toContain('/acme/widget/releases/tag/v1.2.3');
      expect(forge.releases).toEqual([
        { owner: 'acme', repo: 'widget', tag_name: 'v1.2.3', name: 'v1.2.3', body: 'What changed' },
      ]);
    } finally {
      await forge.close();
    }
  });
});
