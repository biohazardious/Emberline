import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runs } from './db/schema.js';
import { noticeFableRoutes } from './factory/fable-routes.js';
import { storedRoadmapItems } from './factory/roadmap.js';
import { updateFactorySettings } from './factory/settings.js';
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
  it("lists new models with the provider's name and a link to Settings", () => {
    notices.newModels('antigravity', [hydrogen, carbon]);
    const [n] = notices.list();
    expect(n).toMatchObject({
      kind: 'new_models',
      title: 'Antigravity has 2 new models',
      text: 'Gemini 4 Hydrogen (High), Gemini 4 Carbon (High)',
      link: '/settings?tab=providers',
      dismissedAt: null,
      key: 'new_models:antigravity:gemini-4-carbon,gemini-4-hydrogen',
    });
    notices.newModels('claude', [{ id: 'x', label: 'X' }]);
    expect(notices.list()[0]!.title).toBe('Claude Code has 1 new model');
  });

  it('names at most ten models, then says how many more', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `m-${String(i).padStart(2, '0')}`,
      label: `M${i}`,
    }));
    notices.newModels('copilot', many);
    const [n] = notices.list();
    expect(n!.title).toBe('GitHub Copilot CLI has 14 new models');
    expect(n!.text).toBe('M0, M1, M2, M3, M4, M5, M6, M7, M8, M9 and 4 more');
  });

  it('does nothing for an empty list', () => {
    notices.newModels('claude', []);
    expect(notices.list()).toEqual([]);
  });

  it('words the failure with the CLI version, or "unknown version"', () => {
    notices.readFailed('claude', '2.1.322', 'the picker did not open');
    expect(notices.list()[0]!.text).toBe(
      "Couldn't read Claude Code's model list (2.1.322): the picker did not open. The last list read stays; you can add a model by hand.",
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

describe('the routes that now really run Fable', () => {
  const createProject = async (name: string) =>
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name, initGit: false },
        headers: authHeaders(cookie),
      })
    ).json<{ project: { id: string; name: string; path: string } }>().project;

  const ranBefore = (projectId: string, path: string) =>
    t.db
      .insert(runs)
      .values({
        id: 'old-run',
        projectId,
        agent: 'claude',
        model: 'fable',
        permissionMode: 'auto',
        state: 'done',
        prompt: 'x',
        worktreePath: path,
        hookTokenHash: 'h',
        stateChangedAt: new Date(),
        createdAt: new Date(),
        endedAt: new Date(),
      })
      .run();

  const item = (title: string, preferredModel: string, status = 'planned') => ({
    id: `item-${title}`,
    milestoneId: 'ms-1',
    title,
    description: '',
    persona: 'architect',
    preferredAgent: 'claude',
    preferredModel,
    status,
    createdAt: new Date().toISOString(),
  });

  it('lists the persona routes and open roadmap items on Fable, once', async () => {
    const project = await createProject('Match-3');
    ranBefore(project.id, project.path);
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(
      path.join(project.path, '.emberline', 'roadmap.json'),
      JSON.stringify({
        milestones: [
          {
            id: 'ms-1',
            code: 'M1',
            title: 'One',
            status: 'planned',
            items: [item('Combo scoring', 'fable'), item('Shipped', 'fable', 'done'), item('Menus', 'opus')],
          },
        ],
        suggestions: [],
        updatedAt: new Date().toISOString(),
      }),
    );
    const firstRead = vi.fn(storedRoadmapItems);
    await noticeFableRoutes(t.db, notices, firstRead);
    expect(firstRead).toHaveBeenCalledWith(project.path);
    expect(notices.list()).toHaveLength(1);
    expect(notices.list()[0]!.text).toBe(
      'Routes on Fable ran on Opus until now; they run on Fable from now on: Product Owner → Claude Fable, System Architect → Claude Fable, Roadmap: Combo scoring (Match-3).',
    );
    // The next start reads no roadmap at all.
    const readItems = vi.fn(async () => []);
    await noticeFableRoutes(t.db, new NoticeService(t.db), readItems);
    expect(readItems).not.toHaveBeenCalled();
    expect(new NoticeService(t.db).list()).toHaveLength(1);
  });

  it('skips roadmap entries that are not objects instead of failing, and shows the notice', async () => {
    const project = await createProject('Odd roadmap');
    ranBefore(project.id, project.path);
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(
      path.join(project.path, '.emberline', 'roadmap.json'),
      JSON.stringify({
        milestones: [
          null,
          'M0',
          { id: 'ms-0', items: 'none' },
          { id: 'ms-1', items: [null, 7, 'x', ['nested'], item('Combo scoring', 'fable')] },
        ],
      }),
    );
    await noticeFableRoutes(t.db, notices);
    expect(notices.list()).toHaveLength(1);
    expect(notices.list()[0]!.text).toContain('Roadmap: Combo scoring (Odd roadmap).');
    expect(notices.fableNoticeShown()).toBe(true);
  });

  it('a fresh install has run nothing on Opus: no notice, and none later', async () => {
    await noticeFableRoutes(t.db, notices);
    expect(notices.list()).toEqual([]);
    const project = await createProject('Later');
    ranBefore(project.id, project.path);
    await noticeFableRoutes(t.db, notices);
    expect(notices.list()).toEqual([]);
  });

  it('a fallback step on Fable is named as one; an unreadable roadmap is skipped', async () => {
    const project = await createProject('Broken roadmap');
    ranBefore(project.id, project.path);
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(project.path, '.emberline', 'roadmap.json'), '{not json');
    updateFactorySettings(t.db, {
      personaRoutes: {
        product_owner: [{ agent: 'claude', model: 'opus', credential: 'login' }],
        architect: [{ agent: 'claude', model: 'opus', credential: 'login' }],
        qa: [
          { agent: 'claude', model: 'sonnet', credential: 'login' },
          { agent: 'claude', model: 'fable', credential: 'login' },
        ],
      },
    });
    await noticeFableRoutes(t.db, notices);
    expect(notices.list()[0]!.text).toContain('from now on: QA & Test Engineer (fallback 1) → Claude Fable.');
  });
});
