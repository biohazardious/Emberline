import type { BrowserActionBody, BrowserViewportSnapshot } from '@emberline/protocol';
import { KeyedMutex } from '../keyed-mutex.js';
import type { RunnerBrowserDaemon, RunnerBrowserQuery, RunnerBrowserSnapshot } from './browser-daemon.js';

export interface BrowserTabOptions {
  defaultUrl: string | null;
  /** Follow the agent's tab: this is the only project whose agent uses a browser now. */
  follow: boolean;
  /** This project's agent uses a browser now (maybe alongside another project's). */
  agentHere: boolean;
  /** The URL this project's agent navigated to last, when known. */
  agentUrl?: string | null;
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
   * until this project's agent session ends, the person asks to follow again, or the project is
   * deleted.
   */
  private readonly pinnedToOwn = new Set<string>();
  private readonly lock = new KeyedMutex();
  /** The labelled tabs (`id=project`) the last orphan check saw, and when; null: check on the next poll. */
  private swept: { tabs: string; at: number } | null = null;
  /** Orphan tab id -> when its close was asked: not asked again while that close is on its way. */
  private readonly closeAsked = new Map<string, number>();

  /**
   * @param knownProjects which of these project ids still exist: tabs labelled with any other are
   *   closed (a project deleted while the runner was away). Default: all of them.
   */
  constructor(
    private readonly daemon: (opts?: { start?: boolean }) => Promise<RunnerBrowserDaemon | null>,
    private readonly knownProjects: (ids: string[]) => Set<string> = (ids) => new Set(ids),
  ) {}

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
        this.sweepOrphans(projectId, snap);
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
        const followed = await this.settle(d, projectId, follow, (q) => d.state(q));
        this.sweepOrphans(projectId, followed);
        return projectView(projectId, followed, false);
      }
      const follow = this.followNow(projectId, opts);
      const snap = await this.settle(d, projectId, follow, (q) => d.action(body, q));
      this.sweepOrphans(projectId, snap);
      const shown = snap.tabs?.find((t) => t.id === snap.activeTabId);
      const ownShown = !snap.following && shown?.projectId === projectId;
      if (ownShown) this.selected.set(projectId, shown.id);
      if (ownShown && follow.follow && CHOOSES_OWN_TAB.has(body.action)) this.pinnedToOwn.add(projectId);
      return projectView(projectId, snap, this.offersFollow(projectId, opts));
    });
  }

  /** The project was deleted: close its tabs (only if the daemon already runs) and forget it. */
  forget(projectId: string): Promise<void> {
    this.swept = null; // the known projects changed: the next poll checks the tabs again
    return this.closeTabsOf(projectId);
  }

  private closeTabsOf(projectId: string): Promise<void> {
    return this.lock.run(projectId, async () => {
      this.selected.delete(projectId);
      this.pinnedToOwn.delete(projectId);
      const d = await this.daemon({ start: false });
      if (d)
        await d.action(
          { action: 'close_project_tabs' },
          query(projectId, null, { defaultUrl: null, follow: false, agentHere: false }),
        );
    });
  }

  /** The options for this request: no following while the person keeps the project's own tab. */
  private followNow(projectId: string, opts: BrowserTabOptions): BrowserTabOptions {
    if (!opts.agentHere) this.pinnedToOwn.delete(projectId); // this project's agent session ended
    return this.pinnedToOwn.has(projectId) ? { ...opts, follow: false } : opts;
  }

  /**
   * Closes the tabs labelled with a project that no longer exists (deleted while the daemon was not
   * running, so `forget` could not close them). Each under that project's own lock, not awaited here.
   * The database is asked only when the labelled tabs changed (or after SWEEP_RECHECK_MS), and a tab
   * whose close was asked is not asked again for CLOSE_ASKED_MS.
   */
  private sweepOrphans(projectId: string, snap: RunnerBrowserSnapshot, now = Date.now()): void {
    const labelled = (snap.tabs ?? []).filter((t): t is typeof t & { projectId: string } => !!t.projectId);
    const tabs = labelled
      .map((t) => `${t.id}=${t.projectId}`)
      .sort()
      .join('\n');
    if (this.swept && this.swept.tabs === tabs && now - this.swept.at < SWEEP_RECHECK_MS) return;
    this.swept = { tabs, at: now };
    for (const [id, at] of this.closeAsked) if (now - at >= CLOSE_ASKED_MS) this.closeAsked.delete(id);
    const pending = labelled.filter((t) => t.projectId !== projectId && !this.closeAsked.has(t.id));
    const owners = [...new Set(pending.map((t) => t.projectId))];
    if (owners.length === 0) return;
    let known: Set<string>;
    try {
      known = this.knownProjects(owners);
    } catch {
      this.swept = null; // the database did not answer: try again on the next poll
      return;
    }
    for (const id of owners) {
      if (known.has(id)) continue;
      for (const t of pending) if (t.projectId === id) this.closeAsked.set(t.id, now);
      void this.closeTabsOf(id).catch(() => undefined);
    }
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
    // A start that found no tab says so in the answer, also once the tab is back: the project's tab
    // was only not shown when it is found again, else it was not open.
    const reason = snap.playtestNotStarted ? { playtestNotStarted: snap.playtestNotStarted } : {};
    const own = snap.tabs?.find((t) => t.projectId === projectId);
    if (own) {
      const again = await d.state(query(projectId, own.id, opts));
      if (!again.tabMissing) {
        this.selected.set(projectId, own.id);
        return snap.playtestNotStarted === 'no_tab'
          ? { ...again, playtestNotStarted: 'tab_not_shown' }
          : { ...again, ...reason };
      }
    }
    const opened = await d.action(
      { action: 'open_tab', url: opts.defaultUrl ?? 'about:blank' },
      query(projectId, null, opts),
    );
    if (!opened.tabMissing && opened.activeTabId) this.selected.set(projectId, opened.activeTabId);
    return { ...opened, ...reason };
  }
}

/** The orphan check runs again after this long even when the labelled tabs did not change. */
const SWEEP_RECHECK_MS = 60_000;
/** How long a tab whose close was asked is left to close before it is asked again. */
const CLOSE_ASKED_MS = 10_000;

function query(projectId: string, tabId: string | null, opts: BrowserTabOptions): RunnerBrowserQuery {
  return {
    projectId,
    tabId,
    follow: opts.follow,
    defaultUrl: opts.defaultUrl,
    ...(opts.follow && opts.agentUrl ? { agentUrl: opts.agentUrl } : {}),
  };
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
