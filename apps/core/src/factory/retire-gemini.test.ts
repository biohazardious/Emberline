import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setModelCatalog } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { getSetting, setSetting } from '../db/index.js';
import { projects, quotaWindows, runEvents, runs } from '../db/schema.js';
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

const oldGeminiRun = (
  fields: {
    id?: string;
    agent?: string;
    state?: string;
    endedAt?: Date | null;
    autoRetryAt?: Date | null;
  } = {},
) => {
  if (!t.db.select().from(projects).all().length) {
    t.db.insert(projects).values({ id: 'p1', name: 'p1', slug: 'p1', path: '/w/p1', createdAt: now }).run();
  }
  t.db
    .insert(runs)
    .values({
      id: fields.id ?? 'old-gemini-run',
      projectId: 'p1',
      agent: fields.agent ?? 'gemini',
      model: 'gemini-pro',
      permissionMode: 'auto',
      state: fields.state ?? 'done',
      prompt: 'x',
      worktreePath: '/w/p1',
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      endedAt: fields.endedAt === undefined ? now : fields.endedAt,
      autoRetryAt: fields.autoRetryAt ?? null,
    })
    .run();
};
const runRow = (id: string) => t.db.select().from(runs).where(eq(runs.id, id)).get()!;
const runEventsOf = (id: string) => t.db.select().from(runEvents).where(eq(runEvents.runId, id)).all();

describe('retiring Gemini CLI on upgrade', () => {
  it('drops a Gemini step even with Antigravity enabled, and the next step takes over', () => {
    store({
      enabledProviders: ['claude', 'gemini', 'antigravity'],
      antigravityTermsAcknowledged: true,
      personaRoutes: geminiQa,
    });
    const result = retire();
    expect(result).toMatchObject({ changed: true, hadRuns: false });
    expect(result.lines).toEqual(['QA & Test Engineer → next in its chain']);
    expect(stored()).toMatchObject({
      enabledProviders: ['claude', 'antigravity'],
      personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'login' }] },
    });
    // Never moved onto Antigravity: Emberline does not add it to a chain for the person.
    expect(getFactorySettings(t.db).personaRoutes.qa).toEqual([
      { agent: 'claude', model: 'sonnet', credential: 'login' },
    ]);
    const [notice] = geminiNotices();
    expect(notice).toMatchObject({
      title: 'Gemini CLI was removed',
      link: '/settings?tab=providers',
      createdAt: now.toISOString(),
    });
    expect(notice!.text).toContain('What changed: QA & Test Engineer → next in its chain.');
    expect(notice!.text).toContain('Antigravity can be added to a route by hand in Settings.');
    expect(notice!.text).toContain('The Gemini API key stays for Aider.');
    expect(notice!.text).toContain('Antigravity now needs its own Google sign-in');
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

  it('drops a Gemini fallback and keeps the steps before and after it as they were', () => {
    store({
      enabledProviders: ['claude', 'gemini', 'antigravity', 'codex'],
      personaRoutes: {
        coder: [
          { agent: 'claude', model: 'opus', credential: 'login' },
          { agent: 'gemini', model: 'gemini-9-ultra', credential: 'login' },
          { agent: 'codex', model: 'gpt-5-codex', credential: 'login' },
        ],
      },
    });
    const result = retire();
    expect((stored() as { personaRoutes: { coder: unknown[] } }).personaRoutes.coder).toEqual([
      { agent: 'claude', model: 'opus', credential: 'login' },
      { agent: 'codex', model: 'gpt-5-codex', credential: 'login' },
    ]);
    expect(result.lines).toEqual(['Software Engineer (fallback 1) → next in its chain']);
  });

  it('leaves an Antigravity step the person put in the chain, and adds none', () => {
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

  it('keeps an Antigravity step stored on the API key; it is read as its login', () => {
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

  it('drops every Gemini step of a chain, one line each', () => {
    store({
      enabledProviders: ['claude', 'gemini'],
      personaRoutes: {
        qa: [
          { agent: 'gemini', model: 'gemini-pro', credential: 'login' },
          { agent: 'gemini', model: 'gemini-flash', credential: 'api_key' },
          { agent: 'claude', model: 'sonnet', credential: 'login' },
        ],
      },
    });
    const result = retire();
    expect(result.lines).toEqual([
      'QA & Test Engineer → next in its chain',
      'QA & Test Engineer (fallback 1) → next in its chain',
    ]);
    expect(getFactorySettings(t.db).personaRoutes.qa).toEqual([
      { agent: 'claude', model: 'sonnet', credential: 'login' },
    ]);
  });

  it('a chain left empty falls to the default agent', () => {
    store({
      enabledProviders: ['claude', 'gemini', 'codex'],
      defaultAgent: 'codex',
      personaRoutes: { qa: [{ agent: 'gemini', model: 'gemini-pro', credential: 'login' }] },
    });
    expect(retire().lines).toEqual(['QA & Test Engineer → next in its chain']);
    expect((stored() as { personaRoutes: { qa: unknown[] } }).personaRoutes.qa).toEqual([]);
    expect(getFactorySettings(t.db).personaRoutes.qa.map((r) => r.agent)).toEqual(['codex']);
  });

  it('drops without a word a step on Gemini when the stored providers did not enable it', () => {
    store({ enabledProviders: ['claude'], personaRoutes: geminiQa });
    const result = retire();
    expect(result).toMatchObject({ changed: true, lines: [] });
    expect(stored()).toMatchObject({
      enabledProviders: ['claude'],
      personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'login' }] },
    });
  });

  it('with no stored provider list (detected), the step may have run and is named', () => {
    store({ personaRoutes: geminiQa });
    const result = retire();
    expect(result.lines).toEqual(['QA & Test Engineer → next in its chain']);
    expect(stored()).not.toHaveProperty('enabledProviders');
    expect(stored()).toMatchObject({
      personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'login' }] },
    });
  });

  it.each([
    { enabledProviders: ['gemini', 'codex', 'antigravity'], expected: 'codex' },
    { enabledProviders: ['gemini', 'antigravity', 'copilot'], expected: 'copilot' },
    { enabledProviders: ['gemini', 'antigravity'], expected: 'claude' },
    { enabledProviders: ['gemini'], expected: 'claude' },
    { enabledProviders: undefined, expected: 'claude' },
  ])(
    'moves the default agent off Gemini to $expected (from $enabledProviders), never to Antigravity',
    ({ enabledProviders, expected }) => {
      store({ ...(enabledProviders ? { enabledProviders } : {}), defaultAgent: 'gemini' });
      const result = retire();
      expect(stored()!.defaultAgent).toBe(expected);
      expect(result.changed).toBe(true);
    },
  );

  it('handles the 0.1.x per-persona agent like a route: dropped', () => {
    store({
      enabledProviders: ['claude', 'gemini', 'antigravity'],
      personaAgents: { ui_ux: 'gemini', coder: 'claude' },
      personaModels: { ui_ux: 'gemini-pro', coder: 'opus' },
    });
    expect(retire().lines).toEqual(['UI/UX Engineer → next in its chain']);
    expect(stored()).toMatchObject({ personaAgents: { coder: 'claude' }, personaModels: { coder: 'opus' } });
    expect(getFactorySettings(t.db).personaRoutes.ui_ux[0]!.agent).not.toBe('antigravity');

    store({
      enabledProviders: ['claude', 'gemini'],
      personaAgents: { ui_ux: 'gemini' },
      personaModels: { ui_ux: 'gemini-pro' },
    });
    expect(retire().lines).toEqual(['UI/UX Engineer → next in its chain']);
    expect(getFactorySettings(t.db).personaRoutes.ui_ux[0]!.agent).toBe('claude');
  });

  it.each(['queued', 'starting', 'working', 'waiting_input', 'rate_limited'])(
    'ends an open %s Gemini run as failed with the reason, so it frees its slot and can be handed off',
    (state) => {
      oldGeminiRun({ state, endedAt: null, autoRetryAt: now });
      const result = retire();
      expect(result.endedRuns).toEqual(['old-gemini-run']);
      expect(result.hadRuns).toBe(true);
      const row = runRow('old-gemini-run');
      expect(row).toMatchObject({ state: 'failed', cancelledAt: null, handedOffTo: null, autoRetryAt: null });
      expect(row.endedAt).toEqual(now);
      expect(runEventsOf('old-gemini-run')).toEqual([
        expect.objectContaining({
          source: 'system',
          type: 'agent_removed',
          state: 'failed',
          payload: { message: 'Gemini CLI is no longer supported. Hand this run off to another agent.' },
        }),
      ]);
      expect(geminiNotices()).toHaveLength(1);
      // Once ended, the next start finds nothing more to end.
      expect(retire().endedRuns).toEqual([]);
    },
  );

  it('keeps the end time of a Gemini run whose process had already ended, and leaves finished runs and known agents alone', () => {
    const earlier = new Date('2026-11-01T00:00:00Z');
    oldGeminiRun({ id: 'limited', state: 'rate_limited', endedAt: earlier });
    oldGeminiRun({ id: 'finished', state: 'done' });
    oldGeminiRun({ id: 'failed', state: 'failed' });
    oldGeminiRun({ id: 'claude-queued', agent: 'claude', state: 'queued', endedAt: null });
    expect(retire().endedRuns).toEqual(['limited']);
    expect(runRow('limited').endedAt).toEqual(earlier);
    expect(runRow('finished').state).toBe('done');
    expect(runRow('claude-queued')).toMatchObject({ state: 'queued', endedAt: null });
    expect(runEventsOf('finished')).toEqual([]);
    expect(runEventsOf('claude-queued')).toEqual([]);
  });

  it('writes all or nothing: a notice that cannot be stored leaves settings, runs and the flag as they were', () => {
    store({ enabledProviders: ['claude', 'gemini'], personaRoutes: geminiQa });
    oldGeminiRun({ state: 'queued', endedAt: null });
    const before = stored();
    const failing = {
      geminiRemovedNoticeShown: () => false,
      geminiRemoved: () => {
        throw new Error('inbox row is corrupt');
      },
    };
    expect(() => retireGemini(t.db, { now, notices: failing })).toThrow('inbox row is corrupt');
    expect(stored()).toEqual(before);
    expect(runRow('old-gemini-run').state).toBe('queued');
    expect(t.notices.geminiRemovedNoticeShown()).toBe(false);
    // The next start does it all and tells.
    expect(retire()).toMatchObject({ changed: true, endedRuns: ['old-gemini-run'] });
    expect(geminiNotices()).toHaveLength(1);
  });

  it('changes nothing the second time and posts no second notice', () => {
    store({ enabledProviders: ['claude', 'gemini'], personaRoutes: geminiQa });
    oldGeminiRun();
    expect(retire().changed).toBe(true);
    const before = stored();
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: true, endedRuns: [] });
    expect(stored()).toEqual(before);
    expect(geminiNotices()).toHaveLength(1);
  });

  it('does nothing on a fresh install: no notice, no settings row', () => {
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: false, endedRuns: [] });
    expect(stored()).toBeUndefined();
    expect(t.notices.list()).toEqual([]);
  });

  it('tells once when only old Gemini runs are left', () => {
    store({ enabledProviders: ['claude'] });
    oldGeminiRun();
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: true, endedRuns: [] });
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
    expect(retire()).toEqual({ changed: false, lines: [], hadRuns: false, endedRuns: [] });
    expect(t.notices.list()).toEqual([]);
    expect(Object.keys(getSetting<object>(t.db, 'models.catalog')!)).toEqual(['claude']);
    expect(t.db.select({ id: quotaWindows.id }).from(quotaWindows).all()).toEqual([{ id: 'w2' }]);
  });
});
