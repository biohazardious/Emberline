import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoticeService } from './notices/service.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let notices: NoticeService;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  notices = t.notices;
});
afterEach(async () => t.close());

const hydrogen = { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (High)' };
const carbon = { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon (High)' };

describe('notice copy', () => {
  it('lists new models with the provider short label and a link to Settings', () => {
    notices.newModels('antigravity', [hydrogen, carbon]);
    const [n] = notices.list();
    expect(n).toMatchObject({
      kind: 'new_models',
      title: 'AGY has 2 new models',
      text: 'Gemini 4 Hydrogen (High), Gemini 4 Carbon (High)',
      link: '/settings?tab=providers',
      dismissedAt: null,
      key: 'new_models:antigravity:gemini-4-carbon,gemini-4-hydrogen',
    });
    notices.newModels('claude', [{ id: 'x', label: 'X' }]);
    expect(notices.list()[0]!.title).toBe('Claude has 1 new model');
  });

  it('does nothing for an empty list', () => {
    notices.newModels('claude', []);
    expect(notices.list()).toEqual([]);
  });

  it('words the failure with the CLI version, or "unknown version"', () => {
    notices.readFailed('claude', '2.1.322', 'the picker did not open');
    expect(notices.list()[0]!.text).toBe(
      "Couldn't read Claude's model list (2.1.322): the picker did not open. The last list read stays; you can add a model by hand.",
    );
    notices.readFailed('antigravity', null, 'timed out');
    expect(notices.list()[0]!.text).toContain('(unknown version): timed out.');
  });

  it('words the Fable notice and shows it once across restarts', () => {
    notices.fableNowFable(['Reviewer route', 'Roadmap item 3']);
    expect(notices.list()[0]).toMatchObject({
      kind: 'fable_now_fable',
      text: 'Routes on Fable ran on Opus until now; they run on Fable from now on: Reviewer route, Roadmap item 3.',
    });
    notices.dismiss(notices.list()[0]!.id);
    const restarted = new NoticeService(t.db);
    restarted.fableNowFable(['Reviewer route']);
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.list()[0]!.dismissedAt).not.toBeNull();
  });
});

describe('dedup and dismissal', () => {
  it('the same key twice is one notice, whatever the order of the models', () => {
    notices.newModels('antigravity', [hydrogen, carbon]);
    notices.newModels('antigravity', [carbon, hydrogen]);
    notices.readFailed('antigravity', null, 'a');
    notices.readFailed('antigravity', null, 'b');
    expect(notices.list()).toHaveLength(2);
  });

  it('a dismissed notice stays dismissed for the same key', () => {
    notices.newModels('antigravity', [hydrogen]);
    notices.dismiss(notices.list()[0]!.id);
    notices.newModels('antigravity', [hydrogen]);
    expect(notices.list()).toHaveLength(1);
    expect(notices.list()[0]!.dismissedAt).not.toBeNull();
  });

  it('readRecovered closes the failure notice, and a later failure is news again', () => {
    notices.readFailed('claude', '1', 'boom');
    notices.readFailed('antigravity', '1', 'boom');
    notices.readRecovered('claude');
    const open = () => notices.list().filter((n) => !n.dismissedAt);
    expect(open().map((n) => n.key)).toEqual(['models_unread:antigravity']);
    notices.readFailed('claude', '1', 'again');
    expect(open().map((n) => n.key)).toEqual(['models_unread:claude', 'models_unread:antigravity']);
  });

  it('notices survive a restart and emit on change', () => {
    const seen: number[] = [];
    notices.on('change', (list) => seen.push(list.length));
    notices.newModels('antigravity', [hydrogen]);
    expect(seen).toEqual([1]);
    expect(new NoticeService(t.db).list()).toHaveLength(1);
  });
});

describe('routes', () => {
  it('lists and dismisses', async () => {
    notices.newModels('antigravity', [hydrogen]);
    const id = notices.list()[0]!.id;
    const list = await t.app.inject({ method: 'GET', url: '/api/notices', headers: authHeaders(cookie) });
    expect(list.json<{ id: string }[]>().map((n) => n.id)).toEqual([id]);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/notices/${id}/dismiss`,
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(notices.list()[0]!.dismissedAt).not.toBeNull();
    const missing = await t.app.inject({
      method: 'POST',
      url: '/api/notices/nope/dismiss',
      headers: authHeaders(cookie),
    });
    expect(missing.statusCode).toBe(404);
  });
});
