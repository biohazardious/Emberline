import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CreateProjectBody } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let headers: Record<string, string>;
beforeEach(async () => {
  t = await createTestApp();
  headers = { ...CSRF, cookie: await setupAndLogin(t.app) };
});
afterEach(async () => {
  await t.close();
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 2)]);
const STATIC: CreateProjectBody = {
  name: 'Bakery Site',
  source: 'new',
  appType: 'static_site',
  presetId: 'static-plain',
  vision: 'A landing page for a small bakery with opening hours and a menu.',
  startFactory: false,
};
const create = (payload: unknown) =>
  t.app.inject({ method: 'POST', url: '/api/projects', headers, payload: payload as object });
const projectDir = () => path.join(t.config.workspacesDir, 'bakery-site');
const file = (name: string, bytes: Buffer, mimeType = 'application/octet-stream') => ({
  name,
  mimeType,
  dataBase64: bytes.toString('base64'),
});

describe('wizard materials: checks before anything is written', () => {
  it('a type mismatch writes nothing and the retry works', async () => {
    const res = await create({ ...STATIC, materials: [file('photo.png', JPEG, 'image/png')] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_materials', message: 'photo.png is not a PNG file.' });
    expect(existsSync(projectDir())).toBe(false);
    expect((await create({ ...STATIC, materials: [file('photo.png', PNG, 'image/png')] })).statusCode).toBe(
      201,
    );
  });

  it('21 files, a bad link or a data: prefix are refused by the schema before the disk', async () => {
    const one = file('a.bin', Buffer.from('x'));
    for (const body of [
      { ...STATIC, materials: Array(21).fill(one) },
      { ...STATIC, referenceUrls: [{ url: 'javascript:alert(1)' }] },
      { ...STATIC, referenceUrls: [{ url: 'https://user:pw@example.com/' }] },
      {
        ...STATIC,
        materials: [{ ...one, dataBase64: `data:application/octet-stream;base64,${one.dataBase64}` }],
      },
    ]) {
      expect((await create(body)).statusCode).toBe(400);
      expect(existsSync(projectDir())).toBe(false);
    }
  });

  it('schema refusals of files and links are invalid_materials with a plain sentence', async () => {
    const res = await create({ ...STATIC, materials: Array(21).fill(file('a.bin', Buffer.from('x'))) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_materials', message: 'Attach at most 20 files.' });
    const link = await create({ ...STATIC, referenceUrls: [{ url: 'javascript:alert(1)' }] });
    expect(link.json()).toMatchObject({
      error: 'invalid_materials',
      message: 'Use a link that starts with http:// or https://.',
    });
  });

  it('materials and links are only for a new project from the wizard', async () => {
    const res = await create({
      name: 'Old Way',
      mode: 'manual',
      referenceUrls: [{ url: 'https://example.com' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(
      'Reference files and links are only accepted when the wizard creates a new project.',
    );
  });

  it(
    '30 MB in three 10 MB files fits the route; one more byte is refused in plain words, not with 413',
    { timeout: 60_000 },
    async () => {
      const tenMb = Buffer.alloc(10 * 1024 * 1024, 0x41);
      const three = ['a.bin', 'b.bin', 'c.bin'].map((n) => file(n, tenMb));
      const over = await create({ ...STATIC, materials: [...three, file('d.bin', Buffer.from('x'))] });
      expect(over.statusCode).toBe(400);
      expect(over.json()).toMatchObject({
        error: 'invalid_materials',
        message: 'The files add up to more than 30 MB.',
      });
      expect(existsSync(projectDir())).toBe(false);
      expect((await create({ ...STATIC, materials: three })).statusCode).toBe(201);
    },
  );
});

describe('body limit', () => {
  const big = 'a'.repeat(2 * 1024 * 1024);
  it('only POST /api/projects takes more than 1 MB', async () => {
    const created = await create({ ...STATIC, vision: big });
    expect(created.statusCode).toBe(400); // the schema refuses the vision; the body itself was accepted
    const previewed = await t.app.inject({
      method: 'POST',
      url: '/api/projects/preview',
      headers,
      payload: { ...STATIC, vision: big },
    });
    expect(previewed.statusCode).toBe(413);
    const other = await t.app.inject({
      method: 'PUT',
      url: '/api/projects/active',
      headers,
      payload: { projectId: big },
    });
    expect(other.statusCode).toBe(413);
  });
});
