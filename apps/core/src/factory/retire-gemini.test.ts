import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setModelCatalog } from '@emberline/protocol';
import { getSetting, setSetting } from '../db/index.js';
import { projects, quotaWindows, runs } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test-utils.js';
import { retireGemini } from './retire-gemini.js';
import { getFactorySettings } from './settings.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  setModelCatalog(null);
  await t.close();
});

const now = new Date('2026-11-15T10:00:00Z');
const store = (value: object) => setSetting(t.db, 'factory.settings', value);
const stored = () => getSetting<Record<string, unknown>>(t.db, 'factory.settings');
const retire = () => retireGemini(t.db, { now, notices: t.notices });
const geminiNotices = () => t.notices.list().filter((n) => n.kind === 'gemini_removed');

const geminiQa = {
  qa: [
    { agent: 'gemini', model: 'gemini-flash', credential: 'api_key' },
    { agent: 'claude', model: 'sonnet', credential: 'login' },
  ],
};

const oldGeminiRun = () => {
  t.db.insert(projects).values({ id: 'p1', name: 'p1', slug: 'p1', path: '/w/p1', createdAt: now }).run();
  t.db
    .insert(runs)
    .values({
      id: 'old-gemini-run',
      projectId: 'p1',
      agent: 'gemini',
      model: 'gemini-pro',
      permissionMode: 'auto',
      state: 'done',
      prompt: 'x',
      worktreePath: '/w/p1',
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      endedAt: now,
    })
    .run();
};

describe('retiring Gemini CLI on upgrade', () => {
  it('moves a Gemini step to Antigravity with the same model when Antigravity is enabled', () => {
    store({
      enabledProviders: ['claude', 'gemini', 'antigravity'],
      antigravityTermsAcknowledged: true,
      personaRoutes: geminiQa,
    });
    const result = retire();
    expect(result).toMatchObject({ changed: true, hadRuns: false });
    expect(result.lines).toEqual(['QA & Test Engineer → Antigravity gemini-flash']);
    expect(stored()).toMatchObject({
      enabledProviders: ['claude', 'antigravity'],
      personaRoutes: {
        qa: [
          { agent: 'antigravity', model: 'gemini-flash', credential: 'login' },
          { agent: 'claude', model: 'sonnet', credential: 'login' },
        ],
      },
    });
    expect(getFactorySettings(t.db).personaRoutes.qa).toEqual([
      { agent: 'antigravity', model: 'gemini-flash', credential: 'login' },
      { agent: 'claude', model: 'sonnet', credential: 'login' },
    ]);
    const [notice] = geminiNotices();
    expect(notice).toMatchObject({
      title: 'Gemini CLI was removed',
      link: '/settings?tab=providers',
      createdAt: now.toISOString(),
    });
    expect(notice!.text).toContain('QA & Test Engineer → Antigravity gemini-flash');
    expect(notice!.text).toContain('The Gemini API key stays for Aider.');
  });

  it("drops the step when Antigravity is not enabled, and the chain's next step takes over", () => {
    store({ enabledProviders: ['claude', 'gemini'], personaRoutes: geminiQa });
    const result = retire();
    expect(result.lines).toEqual(['QA & Test Engineer → next in its chain']);
    expect(stored()).toMatchObject({
      enabledProviders: ['claude'],
      personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'login' }] },
    });
  });

  it("gives Antigravity's own model for a Gemini model it does not have, and names fallbacks", () => {
    store({
      enabledProviders: ['claude', 'gemini', 'antigravity'],
      personaRoutes: {
        coder: [
          { agent: 'claude', model: 'opus', credential: 'login' },
          { agent: 'gemini', model: 'gemini-9-ultra', credential: 'login' },
        ],
      },
    });
    const result = retire();
    const coder = (stored() as { personaRoutes: { coder: { agent: string; model: string }[] } }).personaRoutes
      .coder;
    expect(coder[1]!.agent).toBe('antigravity');
    expect(coder[1]!.model).not.toBe('gemini-9-ultra');
    expect(result.lines).toEqual([`Software Engineer (fallback 1) → Antigravity ${coder[1]!.model}`]);
  });

  it('drops a Gemini step that would repeat an Antigravity step already in the chain', () => {
    store({
      enabledProviders: ['gemini', 'antigravity'],
      personaRoutes: {
        qa: [
          { agent: 'gemini', model: 'gemini-pro', credential: 'login' },
          { agent: 'antigravity', model: 'gemini-pro', credential: 'login' },
        ],
      },
    });
    const result = retire();
    expect(stored()).toMatchObject({
      personaRoutes: { qa: [{ agent: 'antigravity', model: 'gemini-pro', credential: 'login' }] },
    });
    expect(result.lines).toEqual(['QA & Test Engineer → next in its chain']);
  });

  it('counts an Antigravity step stored on the API key as the login step it runs as', () => {
    // Antigravity has no key credential: its api_key step is read as login, so a moved Gemini step
    // would repeat it and the notice must not claim a move that the read then merges away.
    store({
      enabledProviders: ['gemini', 'antigravity'],
      personaRoutes: {
        qa: [
          { agent: 'gemini', model: 'gemini-pro', credential: 'api_key' },
          { agent: 'antigravity', model: 'gemini-pro', credential: 'api_key' },
        ],
      },
    });
    const result = retire();
    expect(result.lines).toEqual(['QA & Test Engineer → next in its chain']);
    expect(getFactorySettings(t.db).personaRoutes.qa).toEqual([
      { agent: 'antigravity', model: 'gemini-pro', credential: 'login' },
    ]);
  });

  it.each([
    { enabledProviders: ['gemini', 'codex', 'antigravity'], expected: 'antigravity' },
    { enabledProviders: ['gemini', 'codex', 'claude'], expected: 'codex' },
    { enabledProviders: ['gemini'], expected: 'claude' },
  ])('moves the default agent off Gemini to $expected', ({ enabledProviders, expected }) => {
    store({ enabledProviders, defaultAgent: 'gemini' });
    const result = retire();
    expect(stored()!.defaultAgent).toBe(expected);
    expect(result.changed).toBe(true);
  });

  it('handles the 0.1.x per-persona agent like a route', () => {
    store({
      enabledProviders: ['claude', 'gemini', 'antigravity'],
      personaAgents: { ui_ux: 'gemini', coder: 'claude' },
      personaModels: { ui_ux: 'gemini-pro', coder: 'opus' },
    });
    expect(retire().lines).toEqual(['UI/UX Engineer → Antigravity gemini-pro']);
    expect(getFactorySettings(t.db).personaRoutes.ui_ux[0]).toEqual({
      agent: 'antigravity',
      model: 'gemini-pro',
      credential: 'login',
    });

    store({
      enabledProviders: ['claude', 'gemini'],
      personaAgents: { ui_ux: 'gemini' },
      personaModels: { ui_ux: 'gemini-pro' },
    });
    expect(retire().lines).toEqual(['UI/UX Engineer → next in its chain']);
    expect(getFactorySettings(t.db).personaRoutes.ui_ux[0]!.agent).toBe('claude');
  });

  it('changes nothing the second time and posts no second notice', () => {
    store({ enabledProviders: ['claude', 'gemini'], personaRoutes: geminiQa });
    oldGeminiRun();
    expect(retire().changed).toBe(true);
    const before = stored();
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: true });
    expect(stored()).toEqual(before);
    expect(geminiNotices()).toHaveLength(1);
  });

  it('does nothing on a fresh install: no notice, no settings row', () => {
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: false });
    expect(stored()).toBeUndefined();
    expect(t.notices.list()).toEqual([]);
  });

  it('tells once when only old Gemini runs are left', () => {
    store({ enabledProviders: ['claude'] });
    oldGeminiRun();
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: true });
    retire();
    const list = geminiNotices();
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toContain('The Gemini API key stays for Aider.');
  });

  it("deletes the catalog's Gemini entry and Gemini's quota windows", () => {
    setSetting(t.db, 'models.catalog', {
      gemini: { models: [], read: null },
      claude: { models: [], read: null },
    });
    const window = (id: string, agent: string) => ({
      id,
      agent,
      exhaustedAt: now,
      resumeAt: now,
      source: 'hook',
    });
    t.db
      .insert(quotaWindows)
      .values([window('w1', 'gemini'), window('w2', 'claude')])
      .run();
    // A list read once is no route that moved: no notice for that alone.
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: false });
    expect(t.notices.list()).toEqual([]);
    expect(Object.keys(getSetting<object>(t.db, 'models.catalog')!)).toEqual(['claude']);
    expect(t.db.select({ id: quotaWindows.id }).from(quotaWindows).all()).toEqual([{ id: 'w2' }]);
  });
});
