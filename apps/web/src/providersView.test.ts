// @vitest-environment happy-dom
import {
  type CliToolStatus,
  FactorySettings,
  type SdkStatus,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { providerStatus } from './components/settings/settingsMeta';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, typeInto, waitFor } from './domRender';
import { SettingsPage } from './pages/SettingsPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const makeTool = (
  provider: CliToolStatus['provider'],
  label: string,
  binaryName: string,
  installed: boolean,
  version: string | null,
  lastError: string | null = null,
): CliToolStatus => ({
  provider,
  label,
  binaryName,
  installed,
  version,
  binaryPath: installed ? `/opt/ai-tools/bin/${binaryName}` : null,
  installMethod: 'npm',
  installCommand: `npm install -g ${binaryName}`,
  updateCommand: `npm update -g ${binaryName}`,
  uninstallCommand: `npm uninstall -g ${binaryName}`,
  installing: false,
  lastAction: null,
  lastUpdatedAt: null,
  lastError,
});

const sdksFixture: SdkStatus[] = [
  {
    id: 'platformio',
    label: 'PlatformIO Core',
    description: 'Embedded C/C++ toolchain.',
    sizeHint: '~400 MB',
    installed: true,
    version: '6.1.16',
    installing: false,
    terminalId: null,
  },
  {
    id: 'android',
    label: 'Android SDK & JDK 21',
    description: 'Command-line tools and OpenJDK 21.',
    sizeHint: '~1.8 GB',
    installed: false,
    version: null,
    installing: false,
    terminalId: null,
  },
];

const makeToolchain = (tools?: CliToolStatus[]): ToolchainStatusResponse => ({
  toolsDir: '/opt/ai-tools',
  osInfo: 'Linux 6.8',
  nodeVersion: 'v22.12.0',
  autoInstallEnabled: true,
  tools: tools ?? [
    makeTool('claude', 'Claude Code', 'claude', true, '1.0.21'),
    makeTool('antigravity', 'Antigravity', 'agy', true, '0.4.2'),
    makeTool('codex', 'Codex CLI', 'codex', false, null),
    makeTool('copilot', 'GitHub Copilot CLI', 'copilot', true, '1.2.3'),
    makeTool('aider', 'Aider', 'aider', true, '0.68.0'),
  ],
  sdks: sdksFixture,
});

function makeSettings(overrides: Partial<FactorySettings> = {}): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
  const auth = (
    authenticated: boolean,
    method: 'oauth_cli' | 'none',
    label: string,
    cliInstalled = true,
  ) => ({
    authenticated,
    method,
    label,
    cliInstalled,
    loginCommandHint: 'login',
  });
  return FactorySettings.parse({
    enabledProviders: ['claude', 'antigravity', 'codex'],
    antigravityTermsAcknowledged: true,
    personaAgents: {},
    personaRoutes: {
      product_owner: [{ agent: 'claude', model: 'fable', credential: 'login' }],
      architect: [{ agent: 'claude', model: 'fable', credential: 'login' }],
      ui_ux: [
        { agent: 'antigravity', model: 'argon', credential: 'login' },
        { agent: 'claude', model: 'opus', credential: 'login' },
      ],
      coder: defaultChain,
      dba: defaultChain,
      qa: [{ agent: 'claude', model: 'sonnet', credential: 'login' }],
      security: defaultChain,
    },
    providerAuth: {
      claude: auth(true, 'oauth_cli', 'Claude Max 20x'),
      antigravity: auth(true, 'oauth_cli', 'Antigravity ready'),
      codex: auth(false, 'none', 'Not signed in', false),
      copilot: auth(false, 'none', 'Not signed in'),
      aider: auth(false, 'none', 'No API key'),
    },
    ...overrides,
  });
}

beforeEach(() => localStorage.clear());
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('providerStatus composite status helper', () => {
  it('returns all six states and enforces precedence: installing → error → off → not_installed → not_signed_in → ready', () => {
    const b = { enabled: false, installing: false, lastError: null, installed: false, signedIn: false };
    expect(providerStatus({ ...b, installing: true, lastError: 'err' })).toMatchObject({
      kind: 'installing',
      label: 'Installing…',
    });
    expect(providerStatus({ ...b, lastError: 'err' })).toMatchObject({
      kind: 'error',
      label: 'Install failed',
    });
    expect(providerStatus(b)).toMatchObject({ kind: 'off', label: 'Off' });
    expect(providerStatus({ ...b, enabled: true })).toMatchObject({
      kind: 'not_installed',
      label: 'CLI not installed',
    });
    expect(providerStatus({ ...b, enabled: true, installed: true })).toMatchObject({
      kind: 'not_signed_in',
      label: 'Not signed in',
    });
    expect(providerStatus({ ...b, enabled: true, installed: true, signedIn: true })).toMatchObject({
      kind: 'ready',
      label: 'Ready',
    });
    expect(
      providerStatus({
        enabled: true,
        toolStatus: { installed: true, installing: false, lastError: null },
        authStatus: { authenticated: true, label: 'Claude Max 20x', cliInstalled: true },
      }),
    ).toEqual({ kind: 'ready', state: 'ready', label: 'Claude Max 20x' });
  });
});

describe('ProvidersSection Agents, Routing and SDKs views (AC-6.2, AC-6.3, AC-6.4)', () => {
  it('AC-6.2: shows one status, one switch and at most one next-step button per collapsed row, plus error, warning and Key stored markers', async () => {
    const initial = makeSettings({
      enabledProviders: ['claude', 'codex', 'copilot'],
      anthropicKeyStored: true,
      geminiKeyStored: true,
      providerAuth: {
        ...makeSettings().providerAuth!,
        claude: {
          authenticated: true,
          method: 'oauth_cli',
          label: 'Claude Max 20x',
          cliInstalled: true,
          loginCommandHint: 'claude login',
          warning: 'Token expires in 10 minutes\nSecond line hidden on collapsed row',
        },
      },
    });
    const toolchain = makeToolchain([
      makeTool('claude', 'Claude Code', 'claude', true, '1.0.21'),
      makeTool('antigravity', 'Antigravity', 'agy', true, '0.4.2', 'agy binary checksum mismatch'),
      makeTool('codex', 'Codex CLI', 'codex', false, null),
      makeTool('copilot', 'GitHub Copilot CLI', 'copilot', true, '1.2.3'),
      makeTool('aider', 'Aider', 'aider', true, '0.68.0'),
    ]);

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => initial,
        'GET /api/toolchain/status': () => toolchain,
        'GET /api/factory/claude-usage': () => ({ available: false, authenticated: false }),
        'GET /api/models': () => ({ catalog: {} }),
      }),
    );

    const { container } = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings?tab=providers&view=unknown_view' },
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Claude Max 20x');
      expect(container.textContent).toContain('1.0.21');
    });

    const rows = [...container.querySelectorAll<HTMLElement>('[data-provider-row]')];
    expect(rows.map((r) => r.getAttribute('data-provider-row'))).toEqual([
      'claude',
      'antigravity',
      'codex',
      'copilot',
      'aider',
    ]);

    for (const row of rows) {
      expect(row.querySelectorAll('[data-provider-status]')).toHaveLength(1);
      expect(row.querySelectorAll('[role="switch"]')).toHaveLength(1);
      const actionBtns = [...row.querySelectorAll('button')].filter(
        (b) => b.getAttribute('role') !== 'switch' && !b.hasAttribute('aria-expanded'),
      );
      expect(actionBtns.length).toBeLessThanOrEqual(1);
    }

    const claudeRow = container.querySelector<HTMLElement>('[data-provider-row="claude"]')!;
    expect(claudeRow.textContent).toContain('1.0.21');
    expect(claudeRow.textContent).toContain('Key stored');
    expect(claudeRow.textContent).toContain('Token expires in 10 minutes');
    expect(claudeRow.textContent).not.toContain('Second line hidden on collapsed row');

    const agyRow = container.querySelector<HTMLElement>('[data-provider-row="antigravity"]')!;
    expect(agyRow.querySelector('[data-provider-status]')?.getAttribute('data-provider-status')).toBe(
      'error',
    );
    expect(agyRow.textContent).toContain('Install failed');
    expect(agyRow.textContent).toContain('agy binary checksum mismatch');

    expect(
      getButton('Install', container.querySelector<HTMLElement>('[data-provider-row="codex"]')!),
    ).toBeTruthy();
    expect(
      getButton('Sign in', container.querySelector<HTMLElement>('[data-provider-row="copilot"]')!),
    ).toBeTruthy();

    const aiderRow = container.querySelector<HTMLElement>('[data-provider-row="aider"]')!;
    expect(aiderRow.textContent).toContain('Off');
    expect(aiderRow.textContent).toContain('Key stored');
  });

  it('AC-6.3: expands Antigravity row when enabled without acknowledgement, refuses disabling last provider inline, and reroutes personas on disable', async () => {
    const initial = makeSettings({
      enabledProviders: ['claude', 'codex'],
      antigravityTermsAcknowledged: false,
      personaRoutes: {
        ...makeSettings().personaRoutes,
        qa: [{ agent: 'codex', model: 'o4-mini', credential: 'login' }],
      },
    });

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => initial,
        'GET /api/toolchain/status': () => makeToolchain(),
        'GET /api/factory/claude-usage': () => ({ available: false, authenticated: false }),
        'GET /api/models': () => ({ catalog: {} }),
      }),
    );

    const { container } = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings?tab=providers' },
    );
    await waitFor(() => {
      expect(container.textContent).toContain('2 of 5 on');
      expect(container.textContent).toContain('1.0.21');
    });

    const agyRow = container.querySelector<HTMLElement>('[data-provider-row="antigravity"]')!;
    const agySwitch = agyRow.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await click(agySwitch);
    expect(agySwitch.getAttribute('aria-checked')).toBe('false');
    expect(agyRow.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(agyRow.querySelector('[role="alert"]')?.textContent).toContain(
      'Accept the Antigravity account risk before enabling it.',
    );
    const ackCheckbox = agyRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(document.activeElement).toBe(ackCheckbox);

    await click(ackCheckbox);
    await click(agySwitch);
    expect(agySwitch.getAttribute('aria-checked')).toBe('true');

    await click(agySwitch);
    const codexRow = container.querySelector<HTMLElement>('[data-provider-row="codex"]')!;
    await click(codexRow.querySelector<HTMLButtonElement>('[role="switch"]')!);
    expect(container.textContent).toContain('1 of 5 on');

    const claudeRow = container.querySelector<HTMLElement>('[data-provider-row="claude"]')!;
    const claudeSwitch = claudeRow.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await click(claudeSwitch);
    expect(claudeSwitch.getAttribute('aria-checked')).toBe('true');
    expect(claudeRow.querySelector('[role="alert"]')?.textContent).toContain(
      'At least one AI provider must remain active.',
    );

    await click(getButton('Routing', container));
    expect(container.querySelector<HTMLElement>('[data-persona-row="qa"]')?.textContent).toContain(
      'Claude · sonnet · Sign-in',
    );
  });

  it('AC-6.4: opens view=routing and view=sdks, preserves draft across views, restores on Discard, and sends exact PATCH on Save', async () => {
    const patches: Record<string, unknown>[] = [];
    const cliActions: { provider: string; body: unknown }[] = [];
    const sdkActions: { id: string; body: unknown }[] = [];
    let updateAllCount = 0;
    const initial = makeSettings();
    const toolchain = makeToolchain();

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => initial,
        'PATCH /api/factory/settings': (body) => {
          const patch = body as Record<string, unknown>;
          patches.push(patch);
          return makeSettings(patch as Partial<FactorySettings>);
        },
        'GET /api/toolchain/status': () => toolchain,
        'POST /api/toolchain/update-all': () => {
          updateAllCount += 1;
          return { updated: ['claude', 'antigravity'], errors: {}, status: toolchain };
        },
        'POST /api/toolchain/claude/action': (body) => {
          cliActions.push({ provider: 'claude', body });
          return { tool: toolchain.tools[0], output: 'ok', terminal: null };
        },
        'POST /api/toolchain/codex/action': (body) => {
          cliActions.push({ provider: 'codex', body });
          return { tool: toolchain.tools[2], output: 'ok', terminal: null };
        },
        'POST /api/toolchain/sdk/android/action': (body) => {
          sdkActions.push({ id: 'android', body });
          return { sdk: sdksFixture[1], terminal: { id: 'term-sdk' } };
        },
        'GET /api/factory/claude-usage': () => ({
          available: true,
          authenticated: true,
          extraUsage: { enabled: true, usedUsd: 4.5, limitUsd: 50, disabledReason: null },
        }),
        'GET /api/models': () => ({ catalog: {} }),
      }),
    );

    const { container } = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings?tab=providers&view=routing' },
    );
    await waitFor(() => {
      expect(container.textContent).toContain('When a provider runs out of quota');
      expect(container.textContent).toContain('Claude extra usage: on · $4.50 of $50.00 this month');
    });

    const qaRow = container.querySelector<HTMLElement>('[data-persona-row="qa"]')!;
    const poRow = container.querySelector<HTMLElement>('[data-persona-row="product_owner"]')!;
    await click(qaRow.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    await click(poRow.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(qaRow.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(poRow.querySelector('button[aria-expanded="true"]')).not.toBeNull();

    const newRunsSelect = [...container.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('New runs'))
      ?.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      newRunsSelect.value = 'fallback';
      newRunsSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect(getButton('Save', container)).toBeTruthy());

    await click(getButton('Agents', container));
    await waitFor(() => expect(container.textContent).toContain('1.0.21'));
    expect(getButton('Save', container)).toBeTruthy();
    await click(getButton('Update all', container));
    await waitFor(() => expect(updateAllCount).toBe(1));
    await waitFor(() => expect(getButton('Update all', container).disabled).toBe(false));

    const codexRow = container.querySelector<HTMLElement>('[data-provider-row="codex"]')!;
    await click(getButton('Install', codexRow));
    await waitFor(() =>
      expect(cliActions).toContainEqual({
        provider: 'codex',
        body: { action: 'install', spawnTerminal: false },
      }),
    );
    await waitFor(() => expect(getButton('Install', codexRow).disabled).toBe(false));

    const claudeRow = container.querySelector<HTMLElement>('[data-provider-row="claude"]')!;
    await click(claudeRow.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(claudeRow.textContent).toContain('make claude-login');
    expect(claudeRow.textContent).toContain('/opt/ai-tools/bin/claude');
    await typeInto(claudeRow.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-ant-test-999');

    await click(getButton('Update', claudeRow));
    await waitFor(() =>
      expect(cliActions).toContainEqual({
        provider: 'claude',
        body: { action: 'update', spawnTerminal: false },
      }),
    );
    await waitFor(() => expect(getButton('Update', claudeRow).disabled).toBe(false));

    await click(getButton('Uninstall', claudeRow));
    await waitFor(() =>
      expect(cliActions).toContainEqual({
        provider: 'claude',
        body: { action: 'uninstall', spawnTerminal: false },
      }),
    );
    await waitFor(() => expect(getButton('Uninstall', claudeRow).disabled).toBe(false));

    await click(getButton('SDKs', container));
    await waitFor(() => expect(container.textContent).toContain('PlatformIO Core'));
    expect(window.location.search).toContain('view=sdks');
    expect(getButton('Save', container)).toBeTruthy();

    await click(getButton('Routing', container));
    await click(getButton('Discard', container));
    expect(queryButton('Save', container)).toBeNull();

    await click(getButton('Apply preset', container));
    const allLowItem = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('All low'),
    )!;
    await click(allLowItem);
    await click(getButton('Save', container));
    await waitFor(() => expect(patches).toHaveLength(1));
    const patchedRoutes = patches[0]?.personaRoutes as Record<string, { model: string }[]>;
    expect(patchedRoutes.coder?.[0]?.model).toBe('haiku');
    await waitFor(() => expect(queryButton('Save', container)).toBeNull());

    await click(getButton('SDKs', container));
    const androidRow = container.querySelector<HTMLElement>('[data-sdk-row="android"]')!;
    await click(getButton('Install', androidRow));
    await waitFor(() => expect(sdkActions).toEqual([{ id: 'android', body: { action: 'install' } }]));
    await waitFor(() => expect(window.location.pathname).toBe('/terminals/term-sdk'));
  });
});
