import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects } from './db/schema.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
});
afterEach(async () => {
  await t.close();
});

describe('project file download', () => {
  it('serves a file whose name is outside Latin-1 with an RFC 5987 file name', async () => {
    const dir = path.join(t.dir, 'p1');
    mkdirSync(dir, { recursive: true });
    t.db
      .insert(projects)
      .values({ id: 'p1', name: 'p1', slug: 'p1', path: dir, createdAt: new Date() })
      .run();
    writeFileSync(path.join(dir, 'çıktı-🚀.txt'), 'hello');

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/projects/p1/files/download?path=${encodeURIComponent('çıktı-🚀.txt')}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello');
    expect(res.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('çıktı-🚀.txt')}`,
    );
  });
});

describe('the explorer never writes .emberline/worktree.yml', () => {
  const REFUSED = {
    error: 'worktree_config_edit_in_settings',
    message: 'Edit this file from Project settings so it is committed and approved.',
  };

  it('refuses to edit, delete or upload it, and to delete .emberline', async () => {
    const dir = path.join(t.dir, 'p1');
    mkdirSync(path.join(dir, '.emberline'), { recursive: true });
    t.db
      .insert(projects)
      .values({ id: 'p1', name: 'p1', slug: 'p1', path: dir, createdAt: new Date() })
      .run();
    const file = path.join(dir, '.emberline', 'worktree.yml');
    writeFileSync(file, 'version: 1\n');
    const send = (method: 'PUT' | 'DELETE' | 'POST', url: string, payload: object) =>
      t.app.inject({ method, url: `/api/projects/p1${url}`, payload, headers: authHeaders(cookie) });

    for (const rel of ['.emberline/worktree.yml', './.emberline/worktree.yml', '.emberline\\worktree.yml']) {
      const put = await send('PUT', '/files/content', { path: rel, content: 'version: 2\n' });
      expect(put.statusCode, rel).toBe(409);
      expect(put.json()).toEqual(REFUSED);
    }
    for (const rel of ['.emberline/worktree.yml', '.emberline', './.emberline/']) {
      const del = await send('DELETE', '/files', { path: rel });
      expect(del.statusCode, rel).toBe(409);
      expect(del.json()).toEqual(REFUSED);
    }
    const upload = await send('POST', '/files/upload', {
      files: [
        { path: 'ok.txt', dataBase64: Buffer.from('fine').toString('base64') },
        { path: '.emberline/worktree.yml', dataBase64: Buffer.from('version: 2\n').toString('base64') },
      ],
    });
    expect(upload.statusCode).toBe(409);
    expect(upload.json()).toEqual(REFUSED);
    expect(existsSync(path.join(dir, 'ok.txt'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('version: 1\n');

    // Other files in the explorer are written as before.
    expect((await send('PUT', '/files/content', { path: 'notes.txt', content: 'hi' })).statusCode).toBe(200);
  });
});
