import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-utils.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('request logging', () => {
  it('never logs a git gateway capability, whatever case, slashes or percent-encoding the path uses', async () => {
    const logs: string[] = [];
    t = await createTestApp({}, {}, {}, undefined, {
      logger: {
        level: 'trace',
        stream: new Writable({
          write(chunk, _enc, done) {
            logs.push(String(chunk));
            done();
          },
        }),
      },
    });
    const base = await t.app.listen({ host: '127.0.0.1', port: 0 });
    const cap = 'CAPabcdefghijklmnopqrstuvwxyz0123456789_-AAAA';
    const paths = [
      `/api/internal/git/${cap}/info/refs`,
      `/API/internal/git/${cap}/info/refs`,
      `/api//internal/git/${cap}/info/refs`,
      `/api/internal%2Fgit/${cap}/info/refs`,
      `/api/internal%2fGIT/${cap}/info/refs`,
      `/%61pi/internal/git/${cap}/info/refs`,
      `/api/internal/git/${cap}/info/refs/`,
      `/api/internal/%67it/${cap}/git-upload-pack`,
    ];
    for (const p of paths) await fetch(`${base}${p}`);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('').toLowerCase()).not.toContain(cap.toLowerCase());
    // Other requests are logged as they are.
    await fetch(`${base}/api/health`);
    expect(logs.join('')).toContain('/api/health');
  });
});
