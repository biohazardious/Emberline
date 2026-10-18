import type { ProjectSettingsResponse } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectSettings, writeIssueSync } from './db/project-settings.js';
import { projects } from './db/schema.js';
import { effectiveFactorySettings, updateFactorySettings } from './factory/settings.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let headers: Record<string, string>;

beforeEach(async () => {
  t = await createTestApp();
  headers = { ...CSRF, cookie: await setupAndLogin(t.app) };
  for (const id of ['a', 'b']) {
    t.db.insert(projects).values({ id, name: id, slug: id, path: `/tmp/${id}`, createdAt: new Date() }).run();
  }
});
afterEach(async () => {
  await t.close();
});

const patch = (id: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'PATCH', url: `/api/projects/${id}/settings`, headers, payload });
const get = async (id: string) =>
  (await t.app.inject({ method: 'GET', url: `/api/projects/${id}/settings`, headers })).json<ProjectSettingsResponse>();

describe('effective gates', () => {
  it('turns a gate off for one project only', async () => {
    expect((await patch('a', { gates: { secretGuardGate: false } })).statusCode).toBe(200);
    expect(effectiveFactorySettings(t.db, 'a').secretGuardGate).toBe(false);
    expect(effectiveFactorySettings(t.db, 'b').secretGuardGate).toBe(true);
  });

  it('inherit follows a later global change; an override does not', async () => {
    await patch('a', { gates: { antiSlopGate: false, crossProviderCritic: true } });
    updateFactorySettings(t.db, { antiSlopGate: true, crossProviderCritic: true, secretGuardGate: false });
    expect(effectiveFactorySettings(t.db, 'a')).toMatchObject({
      antiSlopGate: false,
      crossProviderCritic: true,
      secretGuardGate: false,
    });
    expect(effectiveFactorySettings(t.db, 'b').secretGuardGate).toBe(false);
    updateFactorySettings(t.db, { crossProviderCritic: false });
    expect(effectiveFactorySettings(t.db, 'a').crossProviderCritic).toBe(true);
    expect(effectiveFactorySettings(t.db, 'b').crossProviderCritic).toBe(false);
  });

  it('keeps global-only settings global', async () => {
    await patch('a', { gates: { autoSyncToMain: false } });
    expect(effectiveFactorySettings(t.db, 'a').maxTicketDepth).toBe(effectiveFactorySettings(t.db, 'b').maxTicketDepth);
  });
});

describe('PATCH /api/projects/:id/settings', () => {
  it('reports overrides, effective and global values', async () => {
    await patch('a', { gates: { secretGuardGate: false } });
    updateFactorySettings(t.db, { autoSyncToMain: false });
    const s = await get('a');
    expect(s.gates).toEqual({ secretGuardGate: false });
    expect(s.effective.secretGuardGate).toBe(false);
    expect(s.effective.autoSyncToMain).toBe(false);
    expect(s.global.secretGuardGate).toBe(true);
    expect((await get('b')).gates).toEqual({});
  });

  it('null removes an override', async () => {
    await patch('a', { gates: { secretGuardGate: false, antiSlopGate: false } });
    const res = await patch('a', { gates: { secretGuardGate: null } });
    expect(res.json<ProjectSettingsResponse>().gates).toEqual({ antiSlopGate: false });
    expect((await get('a')).effective.secretGuardGate).toBe(true);
  });

  it('keeps the other keys of the settings row', async () => {
    writeIssueSync(t.db, 'a', { enabled: true } as never);
    await patch('a', { gates: { antiSlopGate: false } });
    expect(readProjectSettings(t.db, 'a').issueSync).toMatchObject({ enabled: true });
  });

  it('rejects unknown gates, non-booleans and other keys', async () => {
    for (const payload of [
      { gates: { nope: true } },
      { gates: { antiSlopGate: 'yes' } },
      { gates: { maxTicketDepth: false } },
      { gates: {}, other: 1 },
      {},
    ]) {
      expect((await patch('a', payload)).statusCode).toBe(400);
    }
    expect((await get('a')).gates).toEqual({});
  });

  it('404s for an unknown project', async () => {
    expect((await patch('zzz', { gates: {} })).statusCode).toBe(404);
  });
});
