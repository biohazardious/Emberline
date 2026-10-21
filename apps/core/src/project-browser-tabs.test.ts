import type { BrowserActionBody } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
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
    return this.snap(q);
  }
  async action(body: RunnerBrowserActionBody, q: RunnerBrowserQuery) {
    await Promise.resolve();
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

const opts = (defaultUrl: string | null, follow = false) => ({ defaultUrl, follow });

describe('ProjectBrowserTabs', () => {
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
