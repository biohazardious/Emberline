import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects } from './db/schema.js';
import { createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

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
    t.db.insert(projects).values({ id: 'p1', name: 'p1', slug: 'p1', path: dir, createdAt: new Date() }).run();
    writeFileSync(path.join(dir, 'çıktı-🚀.txt'), 'hello');

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/projects/p1/files/download?path=${encodeURIComponent('çıktı-🚀.txt')}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello');
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('çıktı-🚀.txt')}`);
  });
});
