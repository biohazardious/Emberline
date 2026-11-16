// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactorySettings } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, typeInto, waitFor } from './domRender';
import { SettingsPage } from './pages/SettingsPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

function makeSettings(overrides: Partial<FactorySettings> = {}): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
  return FactorySettings.parse({
    personaAgents: {},
    personaRoutes: {
      product_owner: defaultChain,
      architect: defaultChain,
      ui_ux: defaultChain,
      coder: defaultChain,
      dba: defaultChain,
      qa: defaultChain,
      security: defaultChain,
    },
    ...overrides,
  });
}

function defaultRoutes(initial = makeSettings(), onPatch?: (body: unknown) => FactorySettings) {
  return apiRoutes({
    'GET /api/factory/settings': () => initial,
    'PATCH /api/factory/settings': (body) =>
      onPatch ? onPatch(body) : makeSettings(body as Partial<FactorySettings>),
    'GET /api/toolchain/status': () => ({
      osInfo: 'Linux',
      nodeVersion: 'v22.12.0',
      toolsDir: '/opt/ai-tools',
      tools: [],
      sdks: [],
    }),
    'GET /api/factory/claude-usage': () => ({ authenticated: false }),
    'GET /api/models': () => ({ catalog: {} }),
    'GET /api/scheduler': () => ({
      window: null,
      windows: [],
      queuedRuns: 0,
      activeRuns: 0,
      lanes: [],
    }),
    'GET /api/forge-accounts': () => ({ accounts: [] }),
    'GET /api/notifications/webhooks': () => ({ webhooks: [] }),
    'GET /api/ssh-key': () => ({ configured: false, publicKey: null, fingerprint: null }),
    'GET /api/ssh-host-keys': () => ({ hosts: [] }),
    'GET /api/updates/status': () => ({
      currentVersion: '0.9.3',
      latestVersion: '0.9.3',
      updateAvailable: false,
      checkedAt: '2026-11-16T00:00:00.000Z',
      channel: 'stable',
      releaseUrl: null,
      releaseNotes: null,
    }),
    'GET /api/auth/session': () => ({ authenticated: true, username: 'admin' }),
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('SettingsPage shell', () => {
  it('renders a single h1 "Settings" and plain tab labels of at most three words', async () => {
    vi.mocked(api).mockImplementation(defaultRoutes());
    const { container } = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings' },
    );

    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Settings');
    expect(container.textContent).not.toContain('Control Center');
    expect(container.textContent).not.toContain('Factory Settings & Multi-Agent Model Routing');

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      'Automation',
      'Providers',
      'MCP and skills',
      'Usage limits',
      'Forges and webhooks',
      'SSH key',
      'Updates',
      'Account',
    ]);
    for (const tab of tabs) {
      const words = (tab.textContent?.trim() ?? '').split(/\s+/);
      expect(words.length).toBeLessThanOrEqual(3);
      expect(tab.classList.contains('btn-primary')).toBe(false);
    }
  });

  it('opens each of the eight ?tab= ids and falls back to Automation for an unknown id', async () => {
    vi.mocked(api).mockImplementation(defaultRoutes());

    const cases: ReadonlyArray<{ query: string; expectedTabId: string; expectedPanelId: string }> = [
      {
        query: '?tab=autopilot',
        expectedTabId: 'settings-tab-autopilot',
        expectedPanelId: 'settings-panel-autopilot',
      },
      {
        query: '?tab=providers',
        expectedTabId: 'settings-tab-providers',
        expectedPanelId: 'settings-panel-providers',
      },
      {
        query: '?tab=mcp_plugins',
        expectedTabId: 'settings-tab-mcp_plugins',
        expectedPanelId: 'settings-panel-mcp_plugins',
      },
      { query: '?tab=quota', expectedTabId: 'settings-tab-quota', expectedPanelId: 'settings-panel-quota' },
      {
        query: '?tab=notifications',
        expectedTabId: 'settings-tab-notifications',
        expectedPanelId: 'settings-panel-notifications',
      },
      {
        query: '?tab=ssh_key',
        expectedTabId: 'settings-tab-ssh_key',
        expectedPanelId: 'settings-panel-ssh_key',
      },
      {
        query: '?tab=updates',
        expectedTabId: 'settings-tab-updates',
        expectedPanelId: 'settings-panel-updates',
      },
      {
        query: '?tab=account',
        expectedTabId: 'settings-tab-account',
        expectedPanelId: 'settings-panel-account',
      },
      {
        query: '?tab=unknown_section',
        expectedTabId: 'settings-tab-autopilot',
        expectedPanelId: 'settings-panel-autopilot',
      },
    ];

    for (const { query, expectedTabId, expectedPanelId } of cases) {
      const view = await renderDom(
        createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
        { path: `/settings${query}` },
      );
      const selectedTab = view.container.querySelector('[role="tab"][aria-selected="true"]');
      expect(selectedTab?.id).toBe(expectedTabId);
      expect(selectedTab?.getAttribute('tabindex')).toBe('0');

      const panel = view.container.querySelector('[role="tabpanel"]');
      expect(panel?.id).toBe(expectedPanelId);
      expect(panel?.getAttribute('aria-labelledby')).toBe(expectedTabId);
      await view.unmount();
    }
  });

  it('moves between tabs with Left, Right, Home and End keys with roving tabIndex', async () => {
    vi.mocked(api).mockImplementation(defaultRoutes());
    const { container } = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings' },
    );

    const tablist = container.querySelector<HTMLElement>('[role="tablist"]')!;
    const fire = (key: string) =>
      act(async () => {
        tablist.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });

    await fire('ArrowRight');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('settings-tab-providers');
    expect(window.location.search).toBe('?tab=providers');

    await fire('End');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('settings-tab-account');
    expect(window.location.search).toBe('?tab=account');

    await fire('ArrowRight');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('settings-tab-autopilot');
    expect(window.location.search).toBe('');

    await fire('ArrowLeft');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('settings-tab-account');

    await fire('Home');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('settings-tab-autopilot');
  });

  it('preserves an edited draft across tab visits, restores saved values on Discard, and sends the exact PATCH body on Save', async () => {
    const patches: Record<string, unknown>[] = [];
    const initial = makeSettings();
    vi.mocked(api).mockImplementation(
      defaultRoutes(initial, (body) => {
        const patch = body as Record<string, unknown>;
        patches.push(patch);
        return makeSettings({
          ...(patch as Partial<FactorySettings>),
          commitIdentity:
            (patch.commitIdentity as FactorySettings['commitIdentity']) ?? initial.commitIdentity,
        });
      }),
    );

    const { container } = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings' },
    );

    await waitFor(() => expect(container.textContent).toContain('Commit identity'));
    expect(queryButton('Save', container)).toBeNull();

    const getNameInput = () =>
      [...container.querySelectorAll('label.field')]
        .find((l) => l.textContent?.includes('Name'))
        ?.querySelector('input') as HTMLInputElement;

    await typeInto(getNameInput(), 'Grace Hopper');
    expect(getNameInput().value).toBe('Grace Hopper');
    expect(getButton('Save', container)).toBeTruthy();

    const beforeUnloadDirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadDirty);
    expect(beforeUnloadDirty.defaultPrevented).toBe(true);

    // Switch to another tab and come back: the unsaved draft survives.
    await click(getButton('Account', container));
    expect(container.querySelector('[role="tabpanel"]')?.id).toBe('settings-panel-account');

    await click(getButton('Automation', container));
    expect(getNameInput().value).toBe('Grace Hopper');
    expect(getButton('Save', container)).toBeTruthy();

    // Discard restores the saved value and hides the SaveBar.
    await click(getButton('Discard', container));
    expect(getNameInput().value).toBe(initial.commitIdentity.name);
    expect(queryButton('Save', container)).toBeNull();

    const beforeUnloadClean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadClean);
    expect(beforeUnloadClean.defaultPrevented).toBe(false);

    // Edit again and Save: sends one PATCH with the full settings payload and shows "Settings saved.".
    await typeInto(getNameInput(), 'Linus Torvalds');
    await click(getButton('Save', container));
    await waitFor(() => expect(patches).toHaveLength(1));

    expect(patches[0]).toEqual({
      theme: initial.theme,
      autoPickupReady: initial.autoPickupReady,
      autoPickupBacklog: initial.autoPickupBacklog,
      autoSyncToMain: initial.autoSyncToMain,
      autoResolveAdditiveConflicts: initial.autoResolveAdditiveConflicts,
      serializeOverlappingTickets: initial.serializeOverlappingTickets,
      selfHealingBuildGate: initial.selfHealingBuildGate,
      antiSlopGate: initial.antiSlopGate,
      secretGuardGate: initial.secretGuardGate,
      requireCompletionSignal: initial.requireCompletionSignal,
      crossProviderCritic: initial.crossProviderCritic,
      autoMoveToDone: initial.autoMoveToDone,
      maxTicketDepth: initial.maxTicketDepth,
      maxAutoRunsPerProjectPerDay: initial.maxAutoRunsPerProjectPerDay,
      maxParallelTicketsPerProject: initial.maxParallelTicketsPerProject,
      buildOutputsQuotaGb: initial.buildOutputsQuotaGb,
      commitIdentity: { name: 'Linus Torvalds', email: initial.commitIdentity.email },
      defaultAgent: initial.defaultAgent,
      enabledProviders: initial.enabledProviders,
      antigravityTermsAcknowledged: initial.antigravityTermsAcknowledged,
      personaRoutes: initial.personaRoutes,
      quotaPolicy: initial.quotaPolicy,
      mcpServers: initial.mcpServers,
      skillPlugins: initial.skillPlugins,
    });

    await waitFor(() => expect(container.textContent).toContain('Settings saved.'));
    expect(queryButton('Save', container)).toBeNull();

    // Next edit clears the "Settings saved." notice.
    await typeInto(getNameInput(), 'Margaret Hamilton');
    expect(container.textContent).not.toContain('Settings saved.');
  });

  it('enforces token-only colours and minimum 0.8rem font sizes in ui.css', () => {
    const css = readFileSync(resolve(HERE, 'ui.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

    const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const rem of fontSizes) {
      expect(rem).toBeGreaterThanOrEqual(0.8);
    }
    expect(css).not.toMatch(/font-size:\s*[0-9.]+px/);
  });
});
