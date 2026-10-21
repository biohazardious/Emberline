import type { BrowserActionBody, BrowserViewportSnapshot } from '@emberline/protocol';
import { KeyedMutex } from '../keyed-mutex.js';
import type { RunnerBrowserDaemon, RunnerBrowserQuery, RunnerBrowserSnapshot } from './browser-daemon.js';

export interface BrowserTabOptions {
  defaultUrl: string | null;
  follow: boolean;
}

/**
 * One tab per project in the runner's shared Chromium. Core remembers which tab a project's Live
 * Browser shows (in memory); the daemon labels the tabs it opened with their project, so after a
 * core restart the project's tab is found again instead of opening another one. A missing tab is
 * replaced by another tab of the project, else reopened at the project's address.
 */
export class ProjectBrowserTabs {
  private readonly selected = new Map<string, string>();
  /**
   * Projects whose person chose their own tab while an agent was followed: the view stays on it
   * until that agent session ends, the person asks to follow again, or the project is deleted.
   */
  private readonly pinnedToOwn = new Set<string>();
  private readonly lock = new KeyedMutex();

  constructor(private readonly daemon: (opts?: { start?: boolean }) => Promise<RunnerBrowserDaemon | null>) {}

  /**
   * The project's tab (opened at `defaultUrl` on first use, re-found or reopened when gone), or the
   * agent's while following. Null when the runner browser is unavailable or does not answer.
   */
  state(projectId: string, opts: BrowserTabOptions): Promise<BrowserViewportSnapshot | null> {
    return this.lock.run(projectId, async () => {
      const d = await this.daemon();
      if (!d) return null;
      const follow = this.followNow(projectId, opts);
      try {
        const snap = await this.settle(d, projectId, follow, (q) => d.state(q));
        return projectView(projectId, snap, this.offersFollow(projectId, opts));
      } catch {
        return null; // as before: the route falls back to a headless capture
      }
    });
  }

  /**
   * Performs a Live Browser action on the project's tab (or the followed agent tab). Null when the
   * runner browser is unavailable; daemon errors propagate.
   */
  action(
    projectId: string,
    body: BrowserActionBody,
    opts: BrowserTabOptions,
  ): Promise<BrowserViewportSnapshot | null> {
    return this.lock.run(projectId, async () => {
      const d = await this.daemon();
      if (!d) return null;
      if (body.action === 'follow_agent') {
        this.pinnedToOwn.delete(projectId);
        const follow = this.followNow(projectId, opts);
        return projectView(projectId, await this.settle(d, projectId, follow, (q) => d.state(q)), false);
      }
      const follow = this.followNow(projectId, opts);
      const snap = await this.settle(d, projectId, follow, (q) => d.action(body, q));
      const shown = snap.tabs?.find((t) => t.id === snap.activeTabId);
      const ownShown = !snap.following && shown?.projectId === projectId;
      if (ownShown) this.selected.set(projectId, shown.id);
      if (ownShown && follow.follow && CHOOSES_OWN_TAB.has(body.action)) this.pinnedToOwn.add(projectId);
      return projectView(projectId, snap, this.offersFollow(projectId, opts));
    });
  }

  /** The project was deleted: close its tabs (only if the daemon already runs) and forget it. */
  forget(projectId: string): Promise<void> {
    return this.lock.run(projectId, async () => {
      this.selected.delete(projectId);
      this.pinnedToOwn.delete(projectId);
      const d = await this.daemon({ start: false });
      if (d)
        await d.action(
          { action: 'close_project_tabs' },
          query(projectId, null, { defaultUrl: null, follow: false }),
        );
    });
  }

  /** The options for this request: no following while the person keeps the project's own tab. */
  private followNow(projectId: string, opts: BrowserTabOptions): BrowserTabOptions {
    if (!opts.follow) this.pinnedToOwn.delete(projectId); // the agent session ended
    return this.pinnedToOwn.has(projectId) ? { ...opts, follow: false } : opts;
  }

  private offersFollow(projectId: string, opts: BrowserTabOptions): boolean {
    return opts.follow && this.pinnedToOwn.has(projectId);
  }

  /**
   * Runs `first` on the project's tab. When that tab is gone: another tab of the project, else a new
   * one at the project's address — each once, and only its state is read (an action meant for the
   * gone page is not replayed on another).
   */
  private async settle(
    d: RunnerBrowserDaemon,
    projectId: string,
    opts: BrowserTabOptions,
    first: (q: RunnerBrowserQuery) => Promise<RunnerBrowserSnapshot>,
  ): Promise<RunnerBrowserSnapshot> {
    const snap = await first(query(projectId, this.selected.get(projectId) ?? null, opts));
    if (!snap.tabMissing) return snap;
    this.selected.delete(projectId);
    const own = snap.tabs?.find((t) => t.projectId === projectId);
    if (own) {
      const again = await d.state(query(projectId, own.id, opts));
      if (!again.tabMissing) {
        this.selected.set(projectId, own.id);
        return again;
      }
    }
    const opened = await d.action(
      { action: 'open_tab', url: opts.defaultUrl ?? 'about:blank' },
      query(projectId, null, opts),
    );
    if (!opened.tabMissing && opened.activeTabId) this.selected.set(projectId, opened.activeTabId);
    return opened;
  }
}

function query(projectId: string, tabId: string | null, opts: BrowserTabOptions): RunnerBrowserQuery {
  return { projectId, tabId, follow: opts.follow, defaultUrl: opts.defaultUrl };
}

/** Actions by which the person picks one of the project's own tabs (pins the view to it while following). */
const CHOOSES_OWN_TAB = new Set<BrowserActionBody['action']>(['select_tab', 'new_tab', 'navigate']);

/** What the project's Live Browser gets: only its own tabs, without the daemon's labels. */
function projectView(
  projectId: string,
  snap: RunnerBrowserSnapshot,
  canFollow: boolean,
): BrowserViewportSnapshot {
  const { tabs, tabMissing: _gone, ...rest } = snap;
  return {
    ...rest,
    tabs: (tabs ?? []).filter((t) => t.projectId === projectId).map(({ projectId: _p, ...t }) => t),
    ...(canFollow ? { canFollow: true } : {}),
  };
}
