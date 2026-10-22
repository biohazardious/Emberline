import net, { type AddressInfo, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  BROWSER_DAEMON_SCRIPT,
  BROWSER_DAEMON_VERSION,
  isBrowsableUrl,
  logBridgeErrorOnce,
  resetBridgeErrorLog,
} from './factory/browser-daemon.js';

/** The daemon is a standalone script run in the runner; its URL guard is evaluated from the source. */
function loadNormalizeNavigateUrl(): (raw: string) => string {
  const match = /function normalizeNavigateUrl\(rawUrl\) \{[\s\S]*?\n\}/.exec(BROWSER_DAEMON_SCRIPT);
  if (!match) throw new Error('normalizeNavigateUrl not found in the daemon script');
  return new Function(`${match[0]}; return normalizeNavigateUrl;`)() as (raw: string) => string;
}

describe('browser daemon navigation (S17)', () => {
  const normalize = loadNormalizeNavigateUrl();

  it('opens web pages and bare hosts', () => {
    expect(normalize('')).toBe('about:blank');
    expect(normalize('about:blank')).toBe('about:blank');
    expect(normalize('https://example.com/a')).toBe('https://example.com/a');
    expect(normalize('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalize('example.com')).toBe('http://example.com/');
  });

  it('refuses file, javascript, data and browser-internal URLs', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'chrome://settings',
    ]) {
      expect(() => normalize(url)).toThrow(/only http\(s\) URLs/);
    }
  });

  it('core applies the same rule before forwarding an action', () => {
    for (const url of ['', 'about:blank', 'https://example.com', 'localhost:5173', 'example.com']) {
      expect(isBrowsableUrl(url)).toBe(true);
      expect(() => normalize(url)).not.toThrow();
    }
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'chrome://settings',
    ]) {
      expect(isBrowsableUrl(url)).toBe(false);
    }
  });
});

type Follow = { seen: Set<string>; last: string | null; urls: Map<string, string> };
function loadTabPickers(): {
  pickAgentTab: (
    pages: Page[],
    labels: Map<string, string>,
    follow: Follow,
    agentUrl?: string | null,
    holdNew?: boolean,
  ) => Page | null;
  pickShownTab: (
    pages: Page[],
    labels: Map<string, string>,
    follow: Follow,
    q: { projectId: string; tabId: string | null; follow: boolean; agentUrl?: string | null },
  ) => { tab: Page; following: boolean } | null;
} {
  const src = (name: string) => {
    const m = new RegExp(`function ${name}\\(([^)]*)\\) \\{[\\s\\S]*?\\n\\}`).exec(BROWSER_DAEMON_SCRIPT);
    if (!m) throw new Error(`${name} not found in the daemon script`);
    return m[0];
  };
  return new Function(
    `let pendingOpens = 0;\n${src('pickAgentTab')}\n${src('pickShownTab')}\nreturn { pickAgentTab, pickShownTab };`,
  )();
}
type Page = { id: string; url: string };

describe('browser daemon tabs per project', () => {
  const { pickShownTab } = loadTabPickers();
  const pages: Page[] = [
    { id: 'start', url: 'about:blank' },
    { id: 'ta', url: 'http://core:7420/a' },
    { id: 'tb', url: 'http://core:7420/b' },
  ];
  const labels = new Map([
    ['ta', 'A'],
    ['tb', 'B'],
  ]);
  const fresh = (): Follow => ({ seen: new Set<string>(), last: null, urls: new Map() });

  it('shows the requested tab only to its own project', () => {
    expect(pickShownTab(pages, labels, fresh(), { projectId: 'A', tabId: 'ta', follow: false })).toEqual({
      tab: pages[1],
      following: false,
    });
    expect(pickShownTab(pages, labels, fresh(), { projectId: 'B', tabId: 'ta', follow: false })).toBeNull();
    expect(pickShownTab(pages, labels, fresh(), { projectId: 'A', tabId: 'gone', follow: false })).toBeNull();
    expect(
      pickShownTab(pages, labels, fresh(), { projectId: 'A', tabId: 'start', follow: false }),
    ).toBeNull();
  });
  it('follows an unlabelled tab with a page loaded; a newly seen one wins', () => {
    const follow = fresh();
    // Nothing loaded in an agent tab yet: the project's tab.
    expect(pickShownTab(pages, labels, follow, { projectId: 'A', tabId: 'ta', follow: true })?.tab.id).toBe(
      'ta',
    );
    const withAgent = [
      ...pages.slice(0, 1).map((p) => ({ ...p, url: 'http://core:7420/x' })),
      ...pages.slice(1),
    ];
    expect(pickShownTab(withAgent, labels, follow, { projectId: 'A', tabId: 'ta', follow: true })).toEqual({
      tab: withAgent[0],
      following: true,
    });
    const newer = [...withAgent, { id: 'agent2', url: 'http://core:7420/y' }];
    expect(pickShownTab(newer, labels, follow, { projectId: 'A', tabId: 'ta', follow: true })?.tab.id).toBe(
      'agent2',
    );
    // A labelled tab is never followed.
    expect(pickShownTab(newer, labels, follow, { projectId: 'B', tabId: 'tb', follow: true })?.tab.id).toBe(
      'agent2',
    );
  });
  it('the daemon version moved with the script', () => {
    expect(BROWSER_DAEMON_VERSION).toBe('1.5.1');
  });
});

describe('browser daemon: which agent tab a following view shows (B-10, B-27)', () => {
  const { pickAgentTab, pickShownTab } = loadTabPickers();
  const fresh = (): Follow => ({ seen: new Set<string>(), last: null, urls: new Map() });
  const none = new Map<string, string>();

  it('an old unlabelled tab whose URL changes wins over a newer static one', () => {
    const follow = fresh();
    expect(pickAgentTab([{ id: 'old', url: 'http://h/1' }], none, follow)?.id).toBe('old');
    expect(
      pickAgentTab(
        [
          { id: 'old', url: 'http://h/1' },
          { id: 'new', url: 'http://h/static' },
        ],
        none,
        follow,
      )?.id,
    ).toBe('new');
    expect(
      pickAgentTab(
        [
          { id: 'old', url: 'http://h/2' },
          { id: 'new', url: 'http://h/static' },
        ],
        none,
        follow,
      )?.id,
    ).toBe('old');
    // Nothing changed since: the view stays where it is.
    expect(
      pickAgentTab(
        [
          { id: 'old', url: 'http://h/2' },
          { id: 'new', url: 'http://h/static' },
        ],
        none,
        follow,
      )?.id,
    ).toBe('old');
  });

  it('a page that only rewrites its hash does not take the view', () => {
    const follow = fresh();
    pickAgentTab([{ id: 'game', url: 'http://h/game#t1' }], none, follow);
    const both = (hash: string) => [
      { id: 'game', url: `http://h/game#${hash}` },
      { id: 'new', url: 'http://h/static' },
    ];
    expect(pickAgentTab(both('t1'), none, follow)?.id).toBe('new');
    expect(pickAgentTab(both('t2'), none, follow)?.id).toBe('new');
    expect(
      pickAgentTab(
        [
          { id: 'game', url: 'http://h/level-2#t3' },
          { id: 'new', url: 'http://h/static' },
        ],
        none,
        follow,
      )?.id,
    ).toBe('game');
  });

  it("the tab at the agent's last navigation (hash ignored) wins over everything", () => {
    const follow = fresh();
    pickAgentTab([{ id: 'old', url: 'http://h/app#start' }], none, follow);
    const pages = [
      { id: 'old', url: 'http://h/app#start' },
      { id: 'new', url: 'http://h/other' },
    ];
    expect(pickAgentTab(pages, none, follow, 'http://h/app#level-2')?.id).toBe('old');
    expect(
      pickShownTab(pages, none, fresh(), {
        projectId: 'A',
        tabId: null,
        follow: true,
        agentUrl: 'http://h/app',
      })?.tab.id,
    ).toBe('old');
  });

  it('a labelled tab is never picked, not even at the agent URL', () => {
    const labels = new Map([['ta', 'A']]);
    const pages = [
      { id: 'ta', url: 'http://h/app' },
      { id: 'agent', url: 'http://h/x' },
    ];
    expect(pickAgentTab(pages, labels, fresh(), 'http://h/app')?.id).toBe('agent');
    expect(pickAgentTab([{ id: 'ta', url: 'http://h/app' }], labels, fresh(), 'http://h/app')).toBeNull();
  });

  it('holds a tab that appears while a project tab is being opened until it is labelled or the open is done', () => {
    const follow = fresh();
    expect(pickAgentTab([{ id: 'agent', url: 'http://h/a' }], none, follow)?.id).toBe('agent');
    const opening = [
      { id: 'agent', url: 'http://h/a' },
      { id: 'opening', url: 'http://h/demo' },
    ];
    expect(pickAgentTab(opening, none, follow, null, true)?.id).toBe('agent');
    expect(follow.seen.has('opening')).toBe(false);
    // Still unlabelled once the open is done: an agent's new tab after all.
    const later = fresh();
    pickAgentTab([{ id: 'agent', url: 'http://h/a' }], none, later);
    pickAgentTab(opening, none, later, null, true);
    expect(pickAgentTab(opening, none, later, null, false)?.id).toBe('opening');
    // Labelled meanwhile: the project's tab, never followed.
    expect(pickAgentTab(opening, new Map([['opening', 'A']]), follow, null, false)?.id).toBe('agent');
  });
});

/** `sharedPages` with its globals injected: the CDP fetch, the label map and its save. */
function loadSharedPages(env: {
  fetch: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  tabProjects: Map<string, string>;
  consoleByTab?: Map<string, unknown>;
  ephemeralTabIds?: Set<string>;
  ephemeralSeenAt?: number;
  now?: number;
}): () => Promise<{ id: string }[]> {
  const src = (re: RegExp, name: string) => {
    const m = re.exec(BROWSER_DAEMON_SCRIPT);
    if (!m) throw new Error(`${name} not found in the daemon script`);
    return m[0];
  };
  const body = [
    src(/function isUserPage\(t\) \{[\s\S]*?\n\}/, 'isUserPage'),
    src(/async function sharedPages\(\) \{[\s\S]*?\n\}/, 'sharedPages'),
    src(/function pruneTabBuffers\(buffers, before, live\) \{[\s\S]*?\n\}/, 'pruneTabBuffers'),
    'return sharedPages;',
  ].join('\n');
  return new Function(
    'fetch',
    'tabProjects',
    'CDP_BASE',
    'attachConsoleListener',
    'saveTabProjects',
    'consoleByTab',
    'actionsByTab',
    'ephemeralTabIds',
    'ephemeralSeenAt',
    'Date',
    body,
  )(
    env.fetch,
    env.tabProjects,
    'http://cdp',
    () => undefined,
    () => undefined,
    env.consoleByTab ?? new Map(),
    new Map(),
    env.ephemeralTabIds ?? new Set(),
    env.ephemeralSeenAt ?? 0,
    { now: () => env.now ?? 0 },
  ) as () => Promise<{ id: string }[]>;
}

describe('browser daemon tab labels', () => {
  const page = (id: string) => ({ id, type: 'page', url: 'http://core:7420/x' });

  it('drops the label of a tab that was closed', async () => {
    const tabProjects = new Map([
      ['ta', 'A'],
      ['gone', 'A'],
    ]);
    const sharedPages = loadSharedPages({
      fetch: async () => ({ ok: true, json: async () => [page('ta')] }),
      tabProjects,
    });
    await sharedPages();
    expect([...tabProjects.keys()]).toEqual(['ta']);
  });

  it('keeps the label of a tab opened while the list was on its way', async () => {
    const tabProjects = new Map([['ta', 'A']]);
    let answer!: () => void;
    const sharedPages = loadSharedPages({
      fetch: () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: true, json: async () => [page('ta')] });
        }),
      tabProjects,
    });
    const listing = sharedPages();
    // Another request opens B's tab and labels it before this list (taken earlier) comes back.
    tabProjects.set('tb', 'B');
    answer();
    await listing;
    expect(tabProjects.get('tb')).toBe('B');
  });

  it("drops the buffers of an agent's own Chromium tabs once that Chromium has not been seen for 10 s (B-31)", async () => {
    const run = async (ageMs: number) => {
      const consoleByTab = new Map<string, unknown>([['eph', ['agent line']]]);
      const sharedPages = loadSharedPages({
        fetch: async () => ({ ok: true, json: async () => [page('ta')] }),
        tabProjects: new Map([['ta', 'A']]),
        consoleByTab,
        ephemeralTabIds: new Set(['eph']),
        ephemeralSeenAt: 100_000,
        now: 100_000 + ageMs,
      });
      await sharedPages();
      return consoleByTab.has('eph');
    };
    expect(await run(11_000)).toBe(false);
    expect(await run(1_000)).toBe(true);
  });
});

describe('browser daemon Auto-Interact per project', () => {
  const src = /function playtestHeldByOther\(running, owner, projectId\) \{[\s\S]*?\n\}/.exec(
    BROWSER_DAEMON_SCRIPT,
  );
  const heldByOther = src
    ? (new Function(`${src[0]}; return playtestHeldByOther;`)() as (
        running: boolean,
        owner: string | null,
        projectId: string,
      ) => boolean)
    : null;

  it("B's stop or start leaves A's running loop alone", () => {
    expect(heldByOther).not.toBeNull();
    expect(heldByOther!(true, 'A', 'B')).toBe(true);
    expect(heldByOther!(true, 'A', 'A')).toBe(false);
    expect(heldByOther!(false, 'A', 'B')).toBe(false);
    expect(heldByOther!(false, null, 'B')).toBe(false);
  });

  it('stop_playtest and start_playtest ask before touching the loop', () => {
    const handle =
      /async function handleAction\(body, q\) \{[\s\S]*?\n\}/.exec(BROWSER_DAEMON_SCRIPT)?.[0] ?? '';
    const stop = /if \(action === 'stop_playtest'\) \{[\s\S]*?\n {2}\}/.exec(handle)?.[0] ?? '';
    const start = /if \(action === 'start_playtest'\) \{[\s\S]*?\n {2}\}/.exec(handle)?.[0] ?? '';
    for (const branch of [stop, start]) {
      expect(branch.indexOf('playtestHeldByOther(')).toBeGreaterThan(-1);
      expect(branch.indexOf('playtestHeldByOther(')).toBeLessThan(
        branch.search(/stopPlaytestLoop\(|startPlaytestLoop\(/),
      );
    }
  });
});

/** Daemon functions by name from the script source (a function ends with `}` at column 0). */
function daemonSource(name: string): string {
  const m = new RegExp(`function ${name}\\(([^)]*)\\) \\{[\\s\\S]*?\\n\\}`).exec(BROWSER_DAEMON_SCRIPT);
  if (!m) throw new Error(`${name} not found in the daemon script`);
  return m[0];
}

describe('browser daemon console and actions per tab', () => {
  type Entry = { text?: string; summary?: string };
  const load = () => {
    const consoleByTab = new Map<string, Entry[]>();
    const actionsByTab = new Map<string | null, Entry[]>();
    const fns = new Function(
      'consoleByTab',
      'actionsByTab',
      `let nextActionId = 1;\n${daemonSource('pushCapped')}\n${daemonSource('pushConsole')}\n${daemonSource('pushDaemonAction')}\n${daemonSource('pruneTabBuffers')}\nreturn { pushConsole, pushDaemonAction, pruneTabBuffers };`,
    )(consoleByTab, actionsByTab) as {
      pushConsole: (level: string, text: string, tabId: string) => void;
      pushDaemonAction: (toolName: string, summary: string, persona: string, tabId: string) => void;
      pruneTabBuffers: (buffers: Map<string, unknown>, before: string[], live: Set<string>) => void;
    };
    return { ...fns, consoleByTab, actionsByTab };
  };

  it("a chatty tab does not push out another tab's console lines or actions", () => {
    const { pushConsole, pushDaemonAction, consoleByTab, actionsByTab } = load();
    pushConsole('log', 'B says hi', 'tb');
    pushDaemonAction('auto_interact_click', 'B clicked', 'qa', 'tb');
    for (let i = 0; i < 100; i++) {
      pushConsole('log', `A line ${i}`, 'ta');
      pushDaemonAction('auto_interact_key', `A key ${i}`, 'qa', 'ta');
    }
    expect(consoleByTab.get('tb')?.map((e) => e.text)).toEqual(['B says hi']);
    expect(actionsByTab.get('tb')?.map((e) => e.summary)).toEqual(['B clicked']);
    expect(consoleByTab.get('ta')).toHaveLength(60);
    expect(consoleByTab.get('ta')?.at(-1)?.text).toBe('A line 99');
    expect(actionsByTab.get('ta')).toHaveLength(40);
  });

  it('drops the buffers of closed tabs, but not of a tab opened while the list was on its way', () => {
    const { pruneTabBuffers } = load();
    const buffers = new Map<string, unknown>([
      ['ta', []],
      ['gone', []],
      ['new', []],
    ]);
    pruneTabBuffers(buffers, ['ta', 'gone'], new Set(['ta']));
    expect([...buffers.keys()]).toEqual(['ta', 'new']);
  });

  it('an entry without a tab is not kept (B-32)', () => {
    const buffers = new Map();
    const pushCapped = new Function(`${daemonSource('pushCapped')}; return pushCapped;`)() as (
      buffers: Map<unknown, unknown>,
      tabId: string | null,
      entry: unknown,
      cap: number,
    ) => void;
    pushCapped(buffers, null, { text: 'x' }, 40);
    expect(buffers.size).toBe(0);
  });

  it('the shown tab reads its own buffers', () => {
    const capture = daemonSource('captureState');
    expect(capture).toContain('consoleByTab.get(tab.id)');
    expect(capture).toContain('actionsByTab.get(tab.id)');
    expect(BROWSER_DAEMON_SCRIPT).not.toMatch(/const consoleLogs = \[\]|const daemonActions = \[\]/);
  });
});

describe('browser daemon localhost:7420 bridge across a daemon upgrade', () => {
  const loadListenWithRetry = () =>
    new Function(
      `let bridgeError = null;\n${daemonSource('listenWithRetry')}; return listenWithRetry;`,
    )() as (
      server: Server | EventEmitter,
      port: number,
      host: string,
      tries: number,
      delayMs: number,
      onGiveUp?: (err: { code?: string }) => void,
    ) => void;

  it('binds once the old daemon has let go of the port', async () => {
    const listenWithRetry = loadListenWithRetry();
    const old = net.createServer();
    await new Promise<void>((r) => old.listen(0, '127.0.0.1', r));
    const port = (old.address() as AddressInfo).port;
    const bridge = net.createServer();
    const bound = new Promise<void>((r) => bridge.once('listening', r));
    listenWithRetry(bridge, port, '127.0.0.1', 40, 25);
    // The old daemon exits a little later.
    await new Promise((r) => setTimeout(r, 120));
    expect(bridge.listening).toBe(false);
    await new Promise<void>((r) => old.close(() => r()));
    await bound;
    expect(bridge.listening).toBe(true);
    await new Promise<void>((r) => bridge.close(() => r()));
  });

  it('the bridge is bound through it, with a bounded wait', () => {
    expect(BROWSER_DAEMON_SCRIPT).toMatch(/listenWithRetry\(bridge, 7420, '127\.0\.0\.1', \d+, \d+[,)]/);
  });

  it('gives up on any other error at once, and on EADDRINUSE once the retries run out (B-33)', async () => {
    const listenWithRetry = loadListenWithRetry();
    const failing = (code: string) => {
      const server = new EventEmitter() as EventEmitter & { listen: () => void; listens: number };
      server.listens = 0;
      server.listen = () => {
        server.listens++;
        setImmediate(() => server.emit('error', Object.assign(new Error(code), { code })));
      };
      return server;
    };
    const denied = failing('EACCES');
    const gaveUp: string[] = [];
    listenWithRetry(denied, 7420, '127.0.0.1', 40, 1, (err) => gaveUp.push(String(err.code)));
    await new Promise((r) => setTimeout(r, 20));
    expect(gaveUp).toEqual(['EACCES']);
    expect(denied.listens).toBe(1);

    const taken = failing('EADDRINUSE');
    listenWithRetry(taken, 7420, '127.0.0.1', 2, 1, (err) => gaveUp.push(String(err.code)));
    await new Promise((r) => setTimeout(r, 60));
    expect(gaveUp).toEqual(['EACCES', 'EADDRINUSE']);
    expect(taken.listens).toBe(3);
  });

  it('/health reports the bridge error, and core logs it once per daemon start', () => {
    expect(BROWSER_DAEMON_SCRIPT).toContain(
      'JSON.stringify({ ok: true, version: DAEMON_VERSION, bridgeError })',
    );
    expect(BROWSER_DAEMON_SCRIPT).toMatch(
      /listenWithRetry\(bridge, 7420, '127\.0\.0\.1', \d+, \d+, \(err\) => \{\s+bridgeError = /,
    );
    const logged: string[] = [];
    resetBridgeErrorLog();
    logBridgeErrorOnce(null, (m) => logged.push(m));
    logBridgeErrorOnce('EACCES', (m) => logged.push(m));
    logBridgeErrorOnce('EACCES', (m) => logged.push(m));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('EACCES');
    resetBridgeErrorLog();
    logBridgeErrorOnce('EACCES', (m) => logged.push(m));
    expect(logged).toHaveLength(2);
  });
});

type ActionQuery = { projectId: string; tabId: string | null; follow: boolean; defaultUrl: string | null };
/** `handleAction` with its globals injected: CDP calls are recorded, `captureState` echoes its query. */
function loadHandleAction(over: {
  tabProjects: Map<string, string>;
  playtestTabId?: string | null;
  playtestProjectId?: string | null;
  playtestTimer?: unknown;
}) {
  const fetched: string[] = [];
  const captured: ActionQuery[] = [];
  const stopped: string[] = [];
  let saves = 0;
  const env: Record<string, unknown> = {
    ensureChromium: async () => true,
    fetch: async (url: string) => {
      fetched.push(url);
      return { ok: true, json: async () => ({ id: 'created' }) };
    },
    CDP_BASE: 'http://cdp',
    tabProjects: over.tabProjects,
    saveTabProjects: () => void saves++,
    captureState: async (q: ActionQuery) => {
      captured.push(q);
      return { message: 'Live Chromium CDP stream', q };
    },
    sharedPages: async () => [],
    resolveShown: async () => ({ pages: [], tab: null, following: false, ephemeral: false }),
    stopPlaytestLoop: (reason: string) => void stopped.push(reason),
    startPlaytestLoop: async () => undefined,
    playtestHeldByOther: new Function(
      `${daemonSource('playtestHeldByOther')}; return playtestHeldByOther;`,
    )(),
    normalizeNavigateUrl: (u: string) => u,
    pushDaemonAction: () => undefined,
    withCdpPage: async () => undefined,
    playtestTabId: over.playtestTabId ?? null,
    playtestProjectId: over.playtestProjectId ?? null,
    playtestTimer: over.playtestTimer ?? null,
    pendingOpens: 0,
    KEY_MAP: {},
    setTimeout: (fn: () => void) => fn(),
  };
  const handle = /async function handleAction\(body, q\) \{[\s\S]*?\n\}/.exec(BROWSER_DAEMON_SCRIPT)?.[0];
  if (!handle) throw new Error('handleAction not found in the daemon script');
  const handleAction = new Function(...Object.keys(env), `${handle}; return handleAction;`)(
    ...Object.values(env),
  ) as (
    body: Record<string, unknown>,
    q: ActionQuery,
  ) => Promise<{ message?: string | null; q: ActionQuery }>;
  return { handleAction, fetched, captured, stopped, saves: () => saves };
}

describe('browser daemon actions keep to the project that asks (B-8, B-29)', () => {
  const qA: ActionQuery = { projectId: 'A', tabId: 'ta', follow: false, defaultUrl: null };
  const labels = () =>
    new Map([
      ['ta', 'A'],
      ['ta2', 'A'],
      ['tb', 'B'],
    ]);

  it("select_tab of B's tab from A activates nothing and shows A's view", async () => {
    const h = loadHandleAction({ tabProjects: labels() });
    await h.handleAction({ action: 'select_tab', tabId: 'tb' }, qA);
    expect(h.fetched.some((u) => u.includes('/json/activate'))).toBe(false);
    expect(h.captured).toEqual([qA]);
  });

  it("select_tab of A's own tab activates it", async () => {
    const h = loadHandleAction({ tabProjects: labels() });
    await h.handleAction({ action: 'select_tab', tabId: 'ta2' }, qA);
    expect(h.fetched).toEqual(['http://cdp/json/activate/ta2']);
    expect(h.captured).toEqual([{ ...qA, tabId: 'ta2', follow: false }]);
  });

  it("close_tab of B's tab from A closes nothing and keeps its label", async () => {
    const tabProjects = labels();
    const h = loadHandleAction({ tabProjects });
    await h.handleAction({ action: 'close_tab', tabId: 'tb' }, qA);
    expect(h.fetched.some((u) => u.includes('/json/close'))).toBe(false);
    expect(tabProjects.get('tb')).toBe('B');
  });

  it("close_tab of A's last own tab is refused", async () => {
    const tabProjects = new Map([
      ['ta', 'A'],
      ['tb', 'B'],
    ]);
    const h = loadHandleAction({ tabProjects });
    await h.handleAction({ action: 'close_tab', tabId: 'ta' }, qA);
    expect(h.fetched).toEqual([]);
    expect(tabProjects.get('ta')).toBe('A');
  });

  it("close_tab of A's second tab closes it, drops its label and saves once", async () => {
    const tabProjects = labels();
    const h = loadHandleAction({ tabProjects });
    await h.handleAction({ action: 'close_tab', tabId: 'ta2' }, qA);
    expect(h.fetched).toEqual(['http://cdp/json/close/ta2']);
    expect(tabProjects.has('ta2')).toBe(false);
    expect(h.saves()).toBe(1);
  });

  it("close_project_tabs closes only A's tabs and stops A's Auto-Interact", async () => {
    const tabProjects = labels();
    const h = loadHandleAction({
      tabProjects,
      playtestTabId: 'ta',
      playtestProjectId: 'A',
      playtestTimer: 1,
    });
    await h.handleAction({ action: 'close_project_tabs' }, qA);
    expect(h.fetched.sort()).toEqual(['http://cdp/json/close/ta', 'http://cdp/json/close/ta2']);
    expect([...tabProjects]).toEqual([['tb', 'B']]);
    expect(h.stopped).toContain('Project removed');
  });

  it("stop_playtest from B leaves A's Auto-Interact running and says why", async () => {
    const h = loadHandleAction({
      tabProjects: labels(),
      playtestTabId: 'ta',
      playtestProjectId: 'A',
      playtestTimer: 1,
    });
    const res = await h.handleAction({ action: 'stop_playtest' }, { ...qA, projectId: 'B', tabId: 'tb' });
    expect(res.message).toBe('Auto-Interact is running for another project.');
    expect(h.stopped).toEqual([]);
  });

  it('a snapshot says when Auto-Interact runs for another project (B-12)', () => {
    expect(daemonSource('captureState')).toMatch(/playtestElsewhere: playtestHeldByOther\(/);
  });
});
