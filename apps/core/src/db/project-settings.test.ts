import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from '../test-utils.js';
import { readRepositorySettings, workingBranchOf, writeProjectSettings } from './project-settings.js';

let t: TestApp;
let projectId: string;

beforeEach(async () => {
  t = await createTestApp();
  const cookie = await setupAndLogin(t.app);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authHeaders(cookie),
    payload: { name: 'Settings App' },
  });
  projectId = res.json().project.id;
});
afterEach(async () => {
  await t.close();
});

describe('repository settings', () => {
  it('an old document reads with auto-pull on and the default branch as the working branch', () => {
    writeProjectSettings(t.db, projectId, { repository: { keepMainPushed: true } });
    const s = readRepositorySettings(t.db, projectId);
    expect(s.autoPull).toBe(true);
    expect(s.pulledOids).toEqual([]);
    expect(s.sync).toBeNull();
    expect(s.releaseDraft).toBeNull();
    expect(s.releaseJob).toBeNull();
    expect(workingBranchOf(s, 'main')).toBe('main');
  });

  it('a stored value that no longer parses falls back per key', () => {
    writeProjectSettings(t.db, projectId, {
      repository: { autoPull: 'yes', pulledOids: 3, workingBranch: 'develop' },
    });
    const s = readRepositorySettings(t.db, projectId);
    expect(s.autoPull).toBe(true);
    expect(s.pulledOids).toEqual([]);
    expect(workingBranchOf(s, 'main')).toBe('develop');
  });
});
