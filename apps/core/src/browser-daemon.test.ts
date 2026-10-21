import net, { type AddressInfo, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BROWSER_DAEMON_SCRIPT, BROWSER_DAEMON_VERSION, isBrowsableUrl } from './factory/browser-daemon.js';

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
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings']) {
      expect(() => normalize(url)).toThrow(/only http\(s\) URLs/);
    }
  });

  it('core applies the same rule before forwarding an action', () => {
    for (const url of ['', 'about:blank', 'https://example.com', 'localhost:5173', 'example.com']) {
      expect(isBrowsableUrl(url)).toBe(true);
      expect(() => normalize(url)).not.toThrow();
    }
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings']) {
      expect(isBrowsableUrl(url)).toBe(false);
    }
  });
});

function loadTabPickers(): {
  pickAgentTab: (pages: Page[], labels: Map<string, string>, follow: { seen: Set<string>; last: string | null }) => Page | null;
  pickShownTab: (pages: Page[], labels: Map<string, string>, follow: { seen: Set<string>; last: string | null }, q: { projectId: string; tabId: string | null; follow: boolean }) => { tab: Page; following: boolean } | null;
} {
  const src = (name: string) => {
    const m = new RegExp(`function ${name}\\(([^)]*)\\) \\{[\\s\\S]*?\\n\\}`).exec(BROWSER_DAEMON_SCRIPT);
    if (!m) throw new Error(`${name} not found in the daemon script`);
    return m[0];
  };
  return new Function(`${src('pickAgentTab')}\n${src('pickShownTab')}\nreturn { pickAgentTab, pickShownTab };`)();
}
type Page = { id: string; url: string };

describe('browser daemon tabs per project', () => {
  const { pickShownTab } = loadTabPickers();
  const pages: Page[] = [
    { id: 'start', url: 'about:blank' },
    { id: 'ta', url: 'http://core:7420/a' },
    { id: 'tb', url: 'http://core:7420/b' },
  ];
  const labels = new Map([['ta', 'A'], ['tb', 'B']]);
  const fresh = () => ({ seen: new Set<string>(), last: null as string | null });

  it("shows the requested tab only to its own project", () => {
    expect(pickShownTab(pages, labels, fresh(), { projectId: 'A', tabId: 'ta', follow: false })).toEqual({ tab: pages[1], following: false });
    expect(pickShownTab(pages, labels, fresh(), { projectId: 'B', tabId: 'ta', follow: false })).toBeNull();
    expect(pickShownTab(pages, labels, fresh(), { projectId: 'A', tabId: 'gone', follow: false })).toBeNull();
    expect(pickShownTab(pages, labels, fresh(), { projectId: 'A', tabId: 'start', follow: false })).toBeNull();
  });
  it('follows an unlabelled tab with a page loaded; a newly seen one wins', () => {
    const follow = fresh();
    // Nothing loaded in an agent tab yet: the project's tab.
    expect(pickShownTab(pages, labels, follow, { projectId: 'A', tabId: 'ta', follow: true })?.tab.id).toBe('ta');
    const withAgent = [...pages.slice(0, 1).map((p) => ({ ...p, url: 'http://core:7420/x' })), ...pages.slice(1)];
    expect(pickShownTab(withAgent, labels, follow, { projectId: 'A', tabId: 'ta', follow: true })).toEqual({ tab: withAgent[0], following: true });
    const newer = [...withAgent, { id: 'agent2', url: 'http://core:7420/y' }];
    expect(pickShownTab(newer, labels, follow, { projectId: 'A', tabId: 'ta', follow: true })?.tab.id).toBe('agent2');
    // A labelled tab is never followed.
    expect(pickShownTab(newer, labels, follow, { projectId: 'B', tabId: 'tb', follow: true })?.tab.id).toBe('agent2');
  });
  it('the daemon version moved with the script', () => {
    expect(BROWSER_DAEMON_VERSION).toBe('1.5.0');
  });
});

/** `sharedPages` with its globals injected: the CDP fetch, the label map and its save. */
function loadSharedPages(env: {
  fetch: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  tabProjects: Map<string, string>;
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
    body,
  )(
    env.fetch,
    env.tabProjects,
    'http://cdp',
    () => undefined,
    () => undefined,
    new Map(),
    new Map(),
    new Set(),
  ) as () => Promise<{ id: string }[]>;
}

describe('browser daemon tab labels', () => {
  const page = (id: string) => ({ id, type: 'page', url: 'http://core:7420/x' });

  it('drops the label of a tab that was closed', async () => {
    const tabProjects = new Map([['ta', 'A'], ['gone', 'A']]);
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
});

describe('browser daemon Auto-Interact per project', () => {
  const src = /function playtestHeldByOther\(running, owner, projectId\) \{[\s\S]*?\n\}/.exec(BROWSER_DAEMON_SCRIPT);
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
    const handle = /async function handleAction\(body, q\) \{[\s\S]*?\n\}/.exec(BROWSER_DAEMON_SCRIPT)?.[0] ?? '';
    const stop = /if \(action === 'stop_playtest'\) \{[\s\S]*?\n {2}\}/.exec(handle)?.[0] ?? '';
    const start = /if \(action === 'start_playtest'\) \{[\s\S]*?\n {2}\}/.exec(handle)?.[0] ?? '';
    for (const branch of [stop, start]) {
      expect(branch.indexOf('playtestHeldByOther(')).toBeGreaterThan(-1);
      expect(branch.indexOf('playtestHeldByOther(')).toBeLessThan(branch.search(/stopPlaytestLoop\(|startPlaytestLoop\(/));
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
    const buffers = new Map<string, unknown>([['ta', []], ['gone', []], ['new', []]]);
    pruneTabBuffers(buffers, ['ta', 'gone'], new Set(['ta']));
    expect([...buffers.keys()]).toEqual(['ta', 'new']);
  });

  it('the shown tab reads its own buffers', () => {
    const capture = daemonSource('captureState');
    expect(capture).toContain('consoleByTab.get(tab.id)');
    expect(capture).toContain('actionsByTab.get(tab.id)');
    expect(BROWSER_DAEMON_SCRIPT).not.toMatch(/const consoleLogs = \[\]|const daemonActions = \[\]/);
  });
});

describe('browser daemon localhost:7420 bridge across a daemon upgrade', () => {
  it('binds once the old daemon has let go of the port', async () => {
    const listenWithRetry = new Function(`${daemonSource('listenWithRetry')}; return listenWithRetry;`)() as (
      server: Server,
      port: number,
      host: string,
      tries: number,
      delayMs: number,
    ) => void;
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
    expect(BROWSER_DAEMON_SCRIPT).toMatch(/listenWithRetry\(bridge, 7420, '127\.0\.0\.1', \d+, \d+\)/);
  });
});
