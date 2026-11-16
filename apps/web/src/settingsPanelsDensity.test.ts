// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ClaudeUsageTelemetry,
  FORGE_SCOPE_HINTS,
  type ForgeAccountsResponse,
  type NotificationSettingsView,
  type SchedulerState,
  type SshKeyPublic,
  type TrustedHostKey,
  type UpdatesResponse,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { AccountSection } from './components/settings/AccountSection';
import { ForgeAccountsSection } from './components/settings/ForgeAccountsSection';
import { QuotaSection } from './components/settings/QuotaSection';
import { SshKeySection } from './components/settings/SshKeySection';
import { UpdatesSection } from './components/settings/UpdatesSection';
import { apiRoutes, cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { visibleWordCount } from './uxDensity';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 0.9.3 default-render visible word counts measured with `visibleWordCount(container)`
 * against the standard fixtures below before the M6 redesign.
 */
export const SETTINGS_PANELS_093_BASELINE_WORDS = {
  quota: 211,
  notifications: 65,
  ssh_key: 125,
  updates: 159,
  account: 32,
} as const;

export const SETTINGS_PANELS_WORD_BUDGET_RATIO = 0.6;

const schedulerFixture: SchedulerState = {
  maxConcurrentRuns: 2,
  busy: 1,
  queued: 0,
  rateLimited: 1,
  window: {
    id: 'w1',
    agent: 'claude',
    credential: 'login',
    pool: '*',
    exhaustedAt: '2026-11-16T01:00:00.000Z',
    resetsAt: '2026-11-16T05:00:00.000Z',
    resumeAt: '2026-11-16T05:00:30.000Z',
    resetSource: 'hook',
    message: "You've hit your limit · resets 5am (UTC)",
    resumedAt: null,
  },
  windows: [
    {
      id: 'w1',
      agent: 'claude',
      credential: 'login',
      pool: '*',
      exhaustedAt: '2026-11-16T01:00:00.000Z',
      resetsAt: '2026-11-16T05:00:00.000Z',
      resumeAt: '2026-11-16T05:00:30.000Z',
      resetSource: 'hook',
      message: "You've hit your limit · resets 5am (UTC)",
      resumedAt: null,
    },
  ],
};

const claudeUsageFixture: ClaudeUsageTelemetry = {
  available: true,
  authenticated: true,
  subscriptionType: 'max',
  rateLimitTier: '20x',
  tokenExpiresAt: '2026-11-16T12:00:00.000Z',
  fiveHour: {
    utilizationPercent: 42,
    resetsAt: '2026-11-16T05:00:00.000Z',
    severity: 'normal',
  },
  sevenDay: {
    utilizationPercent: 18,
    resetsAt: '2026-11-20T00:00:00.000Z',
    severity: 'normal',
  },
  extraUsage: null,
  hourlyTokens: {
    inputTokens: 12000,
    outputTokens: 3400,
    cacheReadTokens: 80000,
    cacheCreationTokens: 4000,
    totalTokens: 99400,
    turnCount: 6,
  },
  dailyTokens: {
    inputTokens: 45000,
    outputTokens: 12000,
    cacheReadTokens: 310000,
    cacheCreationTokens: 18000,
    totalTokens: 385000,
    turnCount: 24,
  },
  weeklyTokens: {
    inputTokens: 180000,
    outputTokens: 54000,
    cacheReadTokens: 1200000,
    cacheCreationTokens: 66000,
    totalTokens: 1500000,
    turnCount: 92,
  },
  limitsUpdatedAt: '2026-11-16T01:30:00.000Z',
  updatedAt: '2026-11-16T01:30:00.000Z',
};

const forgeAccountsFixture: ForgeAccountsResponse = {
  accounts: [
    {
      id: 'a1',
      provider: 'github',
      serverUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      username: 'me',
      tokenConfigured: true,
      scopesHint: FORGE_SCOPE_HINTS.github,
      source: 'settings',
    },
  ],
  legacyTokenUnmatched: false,
};

const notificationsFixture: NotificationSettingsView = {
  enabled: true,
  provider: 'ntfy',
  url: 'https://ntfy.sh/emberline',
  tokenConfigured: false,
  onRateLimited: true,
  onQuotaResumed: true,
  onWaitingInput: true,
  onRunFinished: false,
  onGitEvents: true,
};

const sshKeyFixture: SshKeyPublic = {
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKaaaa emberline',
  fingerprint: 'SHA256:aaaa',
  createdAt: '2026-11-10T09:00:00.000Z' as unknown as Date,
  algorithm: 'ed25519',
};

const hostKeyFixture: TrustedHostKey = {
  host: 'git.example.com',
  port: 2222,
  keyType: 'ssh-ed25519',
  key: 'AAAAhost',
  fingerprint: 'SHA256:host',
  trustedAt: '2026-11-09T09:00:00.000Z' as unknown as Date,
};

const updatesFixture: UpdatesResponse = {
  config: { autoCheck: true, tokenConfigured: false },
  status: {
    checkedAt: '2026-11-16T00:00:00.000Z',
    currentVersion: '0.9.3',
    release: {
      version: '0.9.4',
      url: 'https://github.com/biohazardious/Emberline/releases/tag/v0.9.4',
      notes: '### Fixed\n- Faster startup and quieter logs.',
      publishedAt: '2026-11-15T12:00:00.000Z',
    },
    available: 2,
    items: [
      {
        id: 'emberline',
        kind: 'emberline',
        name: 'Emberline',
        installed: '0.9.3',
        latest: '0.9.4',
        state: 'update_available',
        note: null,
        provider: null,
        mcpId: null,
      },
      {
        id: 'cli-claude',
        kind: 'cli',
        name: 'Claude Code',
        installed: '1.0.20',
        latest: '1.0.21',
        state: 'update_available',
        note: null,
        provider: 'claude',
        mcpId: null,
      },
      {
        id: 'mcp-playwright',
        kind: 'mcp',
        name: 'Playwright MCP',
        installed: '0.0.18',
        latest: '0.0.18',
        state: 'up_to_date',
        note: null,
        provider: null,
        mcpId: 'playwright',
      },
    ],
  },
};

function installBaseRoutes(overrides: Record<string, (body?: unknown) => unknown> = {}) {
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/scheduler': () => schedulerFixture,
      'GET /api/runs': () => [],
      'GET /api/factory/claude-usage': () => claudeUsageFixture,
      'GET /api/factory/settings': () => ({
        enabledProviders: ['claude', 'antigravity'],
        providerAuth: {
          claude: { authenticated: true, label: 'Claude Max 20x' },
          antigravity: { authenticated: true, label: 'Antigravity Ready' },
        },
      }),
      'GET /api/forge/accounts': () => forgeAccountsFixture,
      'GET /api/notifications': () => notificationsFixture,
      'GET /api/ssh-key': () => ({ key: sshKeyFixture }),
      'GET /api/ssh-host-keys': () => ({ hosts: [hostKeyFixture] }),
      'GET /api/updates': () => updatesFixture,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  installBaseRoutes();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
  vi.restoreAllMocks();
});

describe('AC-6.5 Settings panels density budget (at most 60% of 0.9.3 words)', () => {
  it('keeps Usage limits default view at or below 60% of 0.9.3 words', async () => {
    const view = await renderDom(createElement(QuotaSection));
    await waitFor(() => expect(view.container.textContent).toContain('Claude Max 20x'));
    const words = visibleWordCount(view.container);
    const budget = Math.floor(SETTINGS_PANELS_093_BASELINE_WORDS.quota * SETTINGS_PANELS_WORD_BUDGET_RATIO);
    expect(words).toBeLessThanOrEqual(budget);
  });

  it('keeps Forges and webhooks default view at or below 60% of 0.9.3 words', async () => {
    const view = await renderDom(createElement(ForgeAccountsSection));
    await waitFor(() => expect(view.container.textContent).toContain('NTFY ON'));
    const words = visibleWordCount(view.container);
    const budget = Math.floor(
      SETTINGS_PANELS_093_BASELINE_WORDS.notifications * SETTINGS_PANELS_WORD_BUDGET_RATIO,
    );
    expect(words).toBeLessThanOrEqual(budget);
  });

  it('keeps SSH key default view at or below 60% of 0.9.3 words', async () => {
    const view = await renderDom(createElement(SshKeySection));
    await waitFor(() => expect(view.container.textContent).toContain('git.example.com:2222'));
    const words = visibleWordCount(view.container);
    const budget = Math.floor(SETTINGS_PANELS_093_BASELINE_WORDS.ssh_key * SETTINGS_PANELS_WORD_BUDGET_RATIO);
    expect(words).toBeLessThanOrEqual(budget);
  });

  it('keeps Updates default view at or below 60% of 0.9.3 words', async () => {
    const view = await renderDom(createElement(UpdatesSection));
    await waitFor(() => expect(view.container.textContent).toContain('Playwright MCP'));
    const words = visibleWordCount(view.container);
    const budget = Math.floor(SETTINGS_PANELS_093_BASELINE_WORDS.updates * SETTINGS_PANELS_WORD_BUDGET_RATIO);
    expect(words).toBeLessThanOrEqual(budget);
  });

  it('keeps Account default view at or below 60% of 0.9.3 words', async () => {
    const view = await renderDom(createElement(AccountSection));
    const words = visibleWordCount(view.container);
    const budget = Math.floor(SETTINGS_PANELS_093_BASELINE_WORDS.account * SETTINGS_PANELS_WORD_BUDGET_RATIO);
    expect(words).toBeLessThanOrEqual(budget);
  });
});

describe('Settings panels interactive actions and disclosures', () => {
  it('resumes a paused lane, updates parallel runs, and expands Usage details in QuotaSection', async () => {
    const resumedCalls: unknown[] = [];
    const concurrencyCalls: unknown[] = [];
    installBaseRoutes({
      'POST /api/scheduler/resume': (body) => {
        resumedCalls.push(body);
        return { ...schedulerFixture, rateLimited: 0, window: null, windows: [] };
      },
      'PATCH /api/scheduler': (body) => {
        concurrencyCalls.push(body);
        return { ...schedulerFixture, maxConcurrentRuns: 4 };
      },
    });

    const view = await renderDom(createElement(QuotaSection));
    await waitFor(() => expect(view.container.textContent).toContain('Claude Max 20x'));
    expect(view.container.textContent).toContain('Paused until');
    expect(view.container.textContent).toContain('Unknown');

    // Resume the paused lane
    await click(getButton('Resume now', view.container));
    await waitFor(() => expect(resumedCalls).toEqual([{ agent: 'claude', credential: 'login', pool: '*' }]));
    await waitFor(() => expect(view.container.textContent).toContain('Available'));

    // Change parallel runs
    const radio4 = view.container.querySelector<HTMLButtonElement>('#concurrency-4')!;
    await click(radio4);
    await waitFor(() => expect(concurrencyCalls).toEqual([{ maxConcurrentRuns: 4 }]));

    // Expand Usage details disclosure
    expect(view.container.textContent).not.toContain('Hourly token usage');
    await click(getButton('Usage details', view.container));
    expect(view.container.textContent).toContain('Hourly token usage');
    expect(view.container.textContent).toContain('99.4K');
  });

  it('checks and applies updates, toggles auto-check, and opens changelog disclosure in UpdatesSection', async () => {
    let checked = 0;
    let updatedCli = 0;
    const configPatches: unknown[] = [];
    installBaseRoutes({
      'POST /api/updates/check': () => {
        checked += 1;
        return updatesFixture;
      },
      'PATCH /api/updates/config': (body) => {
        configPatches.push(body);
        return {
          ...updatesFixture,
          config: { ...updatesFixture.config, ...(body as Record<string, unknown>) },
        };
      },
      'POST /api/toolchain/claude/action': () => {
        updatedCli += 1;
        return { ok: true, tool: { id: 'claude', version: '1.0.21' }, terminal: null };
      },
    });

    const view = await renderDom(createElement(UpdatesSection));
    await waitFor(() => expect(view.container.textContent).toContain('Claude Code'));

    // Changelog is hidden behind disclosure by default
    expect(view.container.textContent).not.toContain('Faster startup and quieter logs.');
    await click(getButton('Upgrade commands and changelog', view.container));
    expect(view.container.textContent).toContain('Faster startup and quieter logs.');

    // Check now
    await click(getButton('Check now', view.container));
    await waitFor(() => expect(checked).toBe(1));

    // Update CLI
    await click(getButton('Update', view.container));
    await waitFor(() => expect(updatedCli).toBe(1));

    // Toggle auto-check switch
    const autoSwitch = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await click(autoSwitch);
    await waitFor(() => expect(configPatches).toEqual([{ autoCheck: false }]));
  });

  it('changes password and signs out in AccountSection', async () => {
    const passwordBodies: unknown[] = [];
    let loggedOut = 0;
    installBaseRoutes({
      'POST /api/auth/password': (body) => {
        passwordBodies.push(body);
        return { sessionKey: 'new-key' };
      },
      'POST /api/auth/logout': () => {
        loggedOut += 1;
        return { ok: true };
      },
    });

    const view = await renderDom(createElement(AccountSection));

    // HelpHint reveals password rules and reset command
    expect(view.container.textContent).not.toContain('make reset-password');
    const helpBtn = view.container.querySelector<HTMLButtonElement>('[aria-label="About password rules"]')!;
    await click(helpBtn);
    expect(view.container.textContent).toContain('make reset-password');

    const currentInput = view.container.querySelector<HTMLInputElement>('#account-current')!;
    const newInput = view.container.querySelector<HTMLInputElement>('#account-new')!;
    const confirmInput = view.container.querySelector<HTMLInputElement>('#account-confirm')!;

    await typeInto(currentInput, 'old-password-123');
    await typeInto(newInput, 'StrongNewPass!2026');
    await typeInto(confirmInput, 'StrongNewPass!2026');

    await click(getButton('Change password', view.container));
    await waitFor(() =>
      expect(passwordBodies).toEqual([
        { currentPassword: 'old-password-123', newPassword: 'StrongNewPass!2026' },
      ]),
    );
    expect(view.container.textContent).toContain('Password changed.');

    // Sign out
    await click(getButton('Sign out', view.container));
    await waitFor(() => expect(loggedOut).toBe(1));
  });

  it('enforces token-only colours, >= 0.8rem font sizes, and zero inline styles in target files', () => {
    const css = readFileSync(resolve(HERE, 'components/settings/settings-panels.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/font-size:\s*[0-9.]+px/);
    const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const rem of fontSizes) {
      expect(rem).toBeGreaterThanOrEqual(0.8);
    }

    const targetComponentFiles = [
      'components/QuotaPanel.tsx',
      'components/QuotaLanes.tsx',
      'components/quota/QuotaUsageDetails.tsx',
      'components/ForgeAccountsPanel.tsx',
      'components/NotificationsPanel.tsx',
      'components/SshKeyPanel.tsx',
      'components/SshKeyLine.tsx',
      'components/UpdatesPanel.tsx',
      'components/AccountPanel.tsx',
      'components/settings/QuotaSection.tsx',
      'components/settings/ForgeAccountsSection.tsx',
      'components/settings/SshKeySection.tsx',
      'components/settings/UpdatesSection.tsx',
      'components/settings/AccountSection.tsx',
    ];
    for (const rel of targetComponentFiles) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }
  });
});
