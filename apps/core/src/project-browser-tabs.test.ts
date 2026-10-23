import type { BrowserActionBody } from '@emberline/protocol';
import { describe, expect, it, vi } from 'vitest';
import type {
  RunnerBrowserActionBody,
  RunnerBrowserDaemon,
  RunnerBrowserQuery,
  RunnerBrowserSnapshot,
} from './factory/browser-daemon.js';
import { ProjectBrowserTabs } from './factory/project-browser-tabs.js';

type FakePage = { id: string; url: string; projectId: string | null };

class FakeDaemon implements RunnerBrowserDaemon {
  pages: FakePage[] = [{ id: 'start', url: 'about:blank', projectId: null }];
  opened: string[] = [];
  performed: { action: string; tabId: string }[] = [];
  queries: RunnerBrowserQuery[] = [];
  actions: { action: string; projectId: string }[] = [];
  /** While set, `close_project_tabs` waits for it (a close on its way). */
  closeGate: Promise<void> | null = null;
  private next = 1;
  private shown(q: RunnerBrowserQuery): { page: FakePage; following: boolean } | null {
    if (q.follow) {
      const agent = this.pages.find((p) => p.projectId === null && p.url !== 'about:blank');
      if (agent) return { page: agent, following: true };
    }
    const own = this.pages.find((p) => p.id === q.tabId && p.projectId === q.projectId);
    return own ? { page: own, following: false } : null;
  }
  private snap(q: RunnerBrowserQuery): RunnerBrowserSnapshot {
    const s = this.shown(q);
    const tabs = this.pages.map((p) => ({
      id: p.id,
      title: p.id,
      url: p.url,
      active: p.id === s?.page.id,
      projectId: p.projectId,
    }));
    if (!s)
      return {
        available: false,
        source: 'none',
        targetUrl: null,
        imageDataUrl: null,
        capturedAt: 'now',
        message: null,
        tabs,
        tabMissing: true,
      };
    return {
      available: true,
      source: 'cdp_live',
      targetUrl: s.page.url,
      activeTabId: s.page.id,
      tabs,
      following: s.following,
      imageDataUrl: 'data:',
      capturedAt: 'now',
      message: null,
    };
  }
  async state(q: RunnerBrowserQuery) {
    await Promise.resolve();
    this.queries.push(q);
    return this.snap(q);
  }
  async action(body: RunnerBrowserActionBody, q: RunnerBrowserQuery) {
    await Promise.resolve();
    this.queries.push(q);
    this.actions.push({ action: body.action, projectId: q.projectId });
    if (body.action === 'close_project_tabs' && this.closeGate) await this.closeGate;
    if (body.action === 'open_tab' || body.action === 'new_tab') {
      const id = `t${this.next++}`;
      this.pages.push({
        id,
        url: ('url' in body && body.url) || q.defaultUrl || 'about:blank',
        projectId: q.projectId,
      });
      this.opened.push(id);
      return this.snap({ ...q, tabId: id, follow: false });
    }
    if (body.action === 'close_project_tabs') {
      this.pages = this.pages.filter((p) => p.projectId !== q.projectId);
      return this.snap(q);
    }
    if (body.action === 'select_tab') {
      const owned = this.pages.some((p) => p.id === body.tabId && p.projectId === q.projectId);
      return this.snap(owned ? { ...q, tabId: body.tabId!, follow: false } : q);
    }
    if (body.action === 'close_tab') {
      const own = this.pages.filter((p) => p.projectId === q.projectId);
      if (own.length > 1 && own.some((p) => p.id === body.tabId))
        this.pages = this.pages.filter((p) => p.id !== body.tabId);
      return this.snap(q);
    }
    const s = this.shown(q);
    if (!s) return this.snap(q);
    this.performed.push({ action: body.action, tabId: s.page.id });
    if (body.action === 'navigate') s.page.url = body.url!;
    return this.snap(q);
  }
}

const opts = (defaultUrl: string | null, follow = false, agentHere = follow, agentUrl?: string | null) => ({
  defaultUrl,
  follow,
  agentHere,
  ...(agentUrl !== undefined ? { agentUrl } : {}),
});

describe('ProjectBrowserTabs', () => {
  it('a start that found no tab keeps its reason once the tab is reopened (L-18)', async () => {
    const d = new FakeDaemon();
    const action = d.action.bind(d);
    d.action = async (body, q) => {
      const snap = await action(body, q);
      return body.action === 'start_playtest' && snap.tabMissing
        ? { ...snap, playtestNotStarted: 'no_tab' as const }
        : snap;
    };
    const tabs = new ProjectBrowserTabs(async () => d);
    const res = await tabs.action('A', { action: 'start_playtest' }, opts('http://core:7420/demo/a'));
    expect(d.opened).toHaveLength(1);
    expect(res?.activeTabId).toBe(d.opened[0]);
    expect(res?.playtestNotStarted).toBe('no_tab');
    // A later poll does not carry it.
    expect((await tabs.state('A', opts('http://core:7420/demo/a')))?.playtestNotStarted).toBeUndefined();
  });

  it('a start whose tab was open but not shown says so once core finds the tab again (L-18)', async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    await tabs.state('A', opts('http://core:7420/demo/a'));
    const own = d.opened[0]!;
    const action = d.action.bind(d);
    // The daemon does not show the tab core asks for (a stale id), though the project's tab is open.
    d.action = async (body, q) => {
      const snap = await action(body, body.action === 'start_playtest' ? { ...q, tabId: 'gone' } : q);
      return body.action === 'start_playtest' && snap.tabMissing
        ? { ...snap, playtestNotStarted: 'no_tab' as const }
        : snap;
    };
    const res = await tabs.action('A', { action: 'start_playtest' }, opts('http://core:7420/demo/a'));
    expect(d.opened).toEqual([own]);
    expect(res?.activeTabId).toBe(own);
    expect(res?.playtestNotStarted).toBe('tab_not_shown');
  });

  it('opens a project tab once at its demo URL and reuses it', async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    const first = await tabs.state('A', opts('http://core:7420/demo/a'));
    const again = await tabs.state('A', opts('http://core:7420/demo/a'));
    expect(d.opened).toHaveLength(1);
    expect(first?.activeTabId).toBe(d.opened[0]);
    expect(again?.activeTabId).toBe(d.opened[0]);
    expect(again?.targetUrl).toBe('http://core:7420/demo/a');
  });

  it("A's tab untouched by B", async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    const a = await tabs.state('A', opts('http://core:7420/demo/a'));
    await tabs.state('B', opts('http://core:7420/demo/b'));
    await tabs.action(
      'B',
      { action: 'navigate', url: 'http://core:7420/elsewhere' },
      opts('http://core:7420/demo/b'),
    );
    const a2 = await tabs.state('A', opts('http://core:7420/demo/a'));
    expect(a2?.activeTabId).toBe(a?.activeTabId);
    expect(a2?.targetUrl).toBe('http://core:7420/demo/a');
    // Each view lists only its own tabs.
    expect(a2?.tabs?.map((t) => t.id)).toEqual([a?.activeTabId]);
    expect(a2?.tabs?.[0]).not.toHaveProperty('projectId');
  });

  it('recreated once when the tab is gone; another own tab is taken first', async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    const a = await tabs.state('A', opts('http://core:7420/demo/a'));
    const second = await tabs.action(
      'A',
      { action: 'new_tab', url: 'http://core:7420/two' },
      opts('http://core:7420/demo/a'),
    );
    expect(second?.activeTabId).not.toBe(a?.activeTabId);
    d.pages = d.pages.filter((p) => p.id !== second?.activeTabId); // closed by hand
    expect((await tabs.state('A', opts('http://core:7420/demo/a')))?.activeTabId).toBe(a?.activeTabId);
    d.pages = d.pages.filter((p) => p.projectId !== 'A'); // Chromium restarted
    const reopened = await tabs.state('A', opts('http://core:7420/demo/a'));
    expect(d.opened).toHaveLength(3);
    expect(reopened?.targetUrl).toBe('http://core:7420/demo/a');
  });

  it('concurrent polls open one tab', async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    await Promise.all([
      tabs.state('A', opts(null)),
      tabs.state('A', opts(null)),
      tabs.state('A', opts(null)),
    ]);
    expect(d.opened).toHaveLength(1);
  });

  it('an action on a gone tab is not replayed', async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    await tabs.state('A', opts(null));
    d.pages = d.pages.filter((p) => p.projectId !== 'A');
    const res = await tabs.action('A', { action: 'click', x: 10, y: 10 } as BrowserActionBody, opts(null));
    expect(d.performed).toEqual([]);
    expect(res?.activeTabId).toBe(d.opened[1]);
  });

  it("finds the project's labelled tab after a core restart instead of opening another", async () => {
    const d = new FakeDaemon();
    await new ProjectBrowserTabs(async () => d).state('A', opts(null));
    const restarted = new ProjectBrowserTabs(async () => d);
    expect((await restarted.state('A', opts(null)))?.activeTabId).toBe(d.opened[0]);
    expect(d.opened).toHaveLength(1);
  });

  it("another project's tab cannot be selected", async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    const a = await tabs.state('A', opts(null));
    const b = await tabs.state('B', opts(null));
    const res = await tabs.action('B', { action: 'select_tab', tabId: a!.activeTabId! }, opts(null));
    expect(res?.activeTabId).toBe(b?.activeTabId);
  });

  it('follows the agent tab without changing the project tab', async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    const a = await tabs.state('A', opts(null));
    d.pages[0]!.url = 'http://core:7420/agent';
    const followed = await tabs.state('A', opts(null, true));
    expect(followed).toMatchObject({ following: true, activeTabId: 'start' });
    expect(followed?.tabs?.map((t) => t.id)).toEqual([a?.activeTabId]);
    expect((await tabs.state('A', opts(null)))?.activeTabId).toBe(a?.activeTabId);
  });

  describe("the person's choice of the project's own tab while an agent is followed", () => {
    const pinned = async () => {
      const d = new FakeDaemon();
      const tabs = new ProjectBrowserTabs(async () => d);
      const own = await tabs.state('A', opts(null));
      d.pages[0]!.url = 'http://core:7420/agent';
      expect(await tabs.state('A', opts(null, true))).toMatchObject({
        following: true,
        activeTabId: 'start',
      });
      const chosen = await tabs.action(
        'A',
        { action: 'select_tab', tabId: own!.activeTabId! },
        opts(null, true),
      );
      expect(chosen).toMatchObject({ following: false, activeTabId: own?.activeTabId, canFollow: true });
      return { d, tabs, own: own!.activeTabId! };
    };

    it('later polls stay on the own tab and offer to follow', async () => {
      const { tabs, own } = await pinned();
      for (let i = 0; i < 3; i++) {
        expect(await tabs.state('A', opts(null, true))).toMatchObject({
          following: false,
          activeTabId: own,
          canFollow: true,
        });
      }
    });

    it('a new tab while following pins too', async () => {
      const d = new FakeDaemon();
      const tabs = new ProjectBrowserTabs(async () => d);
      await tabs.state('A', opts(null));
      d.pages[0]!.url = 'http://core:7420/agent';
      const opened = await tabs.action(
        'A',
        { action: 'new_tab', url: 'http://core:7420/two' },
        opts(null, true),
      );
      expect(opened).toMatchObject({ following: false, canFollow: true });
      expect(await tabs.state('A', opts(null, true))).toMatchObject({
        following: false,
        activeTabId: opened?.activeTabId,
      });
    });

    it('ends with the agent session: the next one is followed again', async () => {
      const { tabs } = await pinned();
      const quiet = await tabs.state('A', opts(null, false));
      expect(quiet?.canFollow).toBeUndefined();
      expect(await tabs.state('A', opts(null, true))).toMatchObject({
        following: true,
        activeTabId: 'start',
      });
    });

    it('follow_agent follows again', async () => {
      const { d, tabs } = await pinned();
      expect(await tabs.action('A', { action: 'follow_agent' }, opts(null, true))).toMatchObject({
        following: true,
        activeTabId: 'start',
      });
      expect(d.performed).toEqual([]);
      const next = await tabs.state('A', opts(null, true));
      expect(next).toMatchObject({ following: true, activeTabId: 'start' });
      expect(next?.canFollow).toBeUndefined();
    });

    it('a deleted project forgets the choice', async () => {
      const { tabs } = await pinned();
      await tabs.forget('A');
      expect(await tabs.state('A', opts(null, true))).toMatchObject({ following: true });
    });

    it("another project's view is not pinned", async () => {
      const { tabs } = await pinned();
      await tabs.state('B', opts(null));
      expect(await tabs.state('B', opts(null, true))).toMatchObject({
        following: true,
        activeTabId: 'start',
      });
    });
  });

  describe("the pin lasts until this project's agent stops (B-28)", () => {
    const pinnedTo = async () => {
      const d = new FakeDaemon();
      const tabs = new ProjectBrowserTabs(async () => d);
      const own = (await tabs.state('A', opts(null)))!.activeTabId!;
      d.pages[0]!.url = 'http://core:7420/agent';
      const chosen = await tabs.action('A', { action: 'select_tab', tabId: own }, opts(null, true, true));
      expect(chosen).toMatchObject({ following: false, activeTabId: own, canFollow: true });
      return { tabs, own };
    };

    it("another project's agent starting (no following for anyone) keeps the pin", async () => {
      const { tabs, own } = await pinnedTo();
      expect(await tabs.state('A', opts(null, false, true))).toMatchObject({
        following: false,
        activeTabId: own,
      });
      expect(await tabs.state('A', opts(null, true, true))).toMatchObject({
        following: false,
        activeTabId: own,
        canFollow: true,
      });
    });

    it("this project's agent stopping releases it", async () => {
      const { tabs } = await pinnedTo();
      await tabs.state('A', opts(null, false, false));
      expect(await tabs.state('A', opts(null, true, true))).toMatchObject({
        following: true,
        activeTabId: 'start',
      });
    });
  });

  it("passes the agent's last URL to the daemon only while following", async () => {
    const d = new FakeDaemon();
    const tabs = new ProjectBrowserTabs(async () => d);
    await tabs.state('A', opts(null, true, true, 'http://localhost:5173/'));
    expect(d.queries.at(-1)?.agentUrl).toBe('http://localhost:5173/');
    await tabs.state('A', opts(null, false, true, 'http://localhost:5173/'));
    expect(d.queries.at(-1)?.agentUrl ?? null).toBeNull();
  });

  describe("deleted projects' tabs are cleaned up (B-7)", () => {
    it('a poll closes the tabs of a project that no longer exists', async () => {
      const d = new FakeDaemon();
      d.pages.push({ id: 'orphan', url: 'http://core:7420/gone', projectId: 'gone' });
      const tabs = new ProjectBrowserTabs(
        async () => d,
        (ids) => new Set(ids.filter((id) => id === 'A')),
      );
      await tabs.state('A', opts(null));
      await vi.waitFor(() =>
        expect(d.actions).toContainEqual({ action: 'close_project_tabs', projectId: 'gone' }),
      );
      expect(d.pages.some((p) => p.projectId === 'gone')).toBe(false);
    });

    it('a project deleted while the runner was away has its tabs closed later', async () => {
      const d = new FakeDaemon();
      let up = false;
      const tabs = new ProjectBrowserTabs(
        async () => (up ? d : null),
        (ids) => new Set(ids.filter((id) => id === 'A')),
      );
      d.pages.push({ id: 'x1', url: 'http://core:7420/x', projectId: 'X' });
      await tabs.forget('X');
      up = true;
      await tabs.state('A', opts(null));
      await vi.waitFor(() => expect(d.pages.some((p) => p.projectId === 'X')).toBe(false));
    });

    it('asks once while the close is on its way, even when the tab list changes meanwhile', async () => {
      const d = new FakeDaemon();
      let land!: () => void;
      d.closeGate = new Promise((r) => (land = r));
      d.pages.push({ id: 'orphan', url: 'http://core:7420/gone', projectId: 'gone' });
      const tabs = new ProjectBrowserTabs(
        async () => d,
        (ids) => new Set(ids.filter((id) => id !== 'gone')),
      );
      await tabs.state('A', opts(null));
      await tabs.state('B', opts(null)); // B's tab is new: the list changed
      await tabs.state('A', opts(null));
      const closes = () =>
        d.actions.filter((a) => a.action === 'close_project_tabs' && a.projectId === 'gone');
      await vi.waitFor(() => expect(closes()).toHaveLength(1));
      land();
      await vi.waitFor(() => expect(d.pages.some((p) => p.projectId === 'gone')).toBe(false));
      await tabs.state('A', opts(null));
      expect(closes()).toHaveLength(1);
    });

    it('looks the owners up only when the tab list changed', async () => {
      const d = new FakeDaemon();
      let lookups = 0;
      const tabs = new ProjectBrowserTabs(
        async () => d,
        (ids) => {
          lookups++;
          return new Set(ids);
        },
      );
      await tabs.state('B', opts(null));
      await tabs.state('A', opts(null));
      expect(lookups).toBe(1);
      await tabs.state('A', opts(null));
      await tabs.state('B', opts(null));
      expect(lookups).toBe(1);
      await tabs.action('B', { action: 'new_tab', url: 'http://core:7420/two' }, opts(null));
      await tabs.state('A', opts(null));
      expect(lookups).toBe(2);
    });

    it('a project forgotten while the runner was away is looked up again though the list is the same', async () => {
      const d = new FakeDaemon();
      let up = true;
      const existing = new Set(['A', 'X']);
      const tabs = new ProjectBrowserTabs(
        async () => (up ? d : null),
        (ids) => new Set(ids.filter((id) => existing.has(id))),
      );
      await tabs.state('X', opts(null));
      await tabs.state('A', opts(null));
      up = false;
      existing.delete('X');
      await tabs.forget('X');
      up = true;
      await tabs.state('A', opts(null));
      await vi.waitFor(() => expect(d.pages.some((p) => p.projectId === 'X')).toBe(false));
    });

    it("another existing project's tabs are left alone", async () => {
      const d = new FakeDaemon();
      const tabs = new ProjectBrowserTabs(
        async () => d,
        (ids) => new Set(ids),
      );
      await tabs.state('B', opts(null));
      await tabs.state('A', opts(null));
      await Promise.resolve();
      expect(d.actions.filter((a) => a.action === 'close_project_tabs')).toEqual([]);
      expect(d.pages.some((p) => p.projectId === 'B')).toBe(true);
    });
  });

  it('null while the runner browser is unavailable; a failing state call is null too', async () => {
    expect(await new ProjectBrowserTabs(async () => null).state('A', opts(null))).toBeNull();
    const broken = new FakeDaemon();
    broken.state = () => Promise.reject(new Error('socket hang up'));
    expect(await new ProjectBrowserTabs(async () => broken).state('A', opts(null))).toBeNull();
  });

  it('forget closes the project tabs only when the daemon already runs', async () => {
    const d = new FakeDaemon();
    const starts: (boolean | undefined)[] = [];
    const tabs = new ProjectBrowserTabs(async (o) => {
      starts.push(o?.start);
      return d;
    });
    await tabs.state('A', opts(null));
    await tabs.forget('A');
    expect(d.pages.some((p) => p.projectId === 'A')).toBe(false);
    expect(starts.at(-1)).toBe(false);
  });
});
