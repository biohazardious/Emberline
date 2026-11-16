// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CliToolStatus,
  FactorySettings,
  type SdkStatus,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { SdkToolchainPanel } from './components/SdkToolchainPanel';
import { ProvidersSection } from './components/settings/ProvidersSection';
import { RoutingView } from './components/settings/providers/RoutingView';
import { providerDraftFrom } from './components/settings/settingsDraft';
import type { ProviderSectionForm } from './components/settings/settingsMeta';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';
import { visibleWordCount } from './uxDensity';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 0.9.3 default-render visible word counts measured with `visibleWordCount(container)`
 * against the five-provider fixture below before the M6 redesign:
 * - Full Providers tab default render: 1140 words
 * - Step 1 Provider cards section alone: 455 words
 * - Step 2 Persona routing section alone: 601 words
 * - Project SDKs section alone: 84 words
 */
export const PROVIDERS_TAB_093_BASELINE_WORDS = 1140;
export const PROVIDERS_AGENTS_093_BASELINE_WORDS = 455;
export const PROVIDERS_ROUTING_093_BASELINE_WORDS = 601;
export const PROVIDERS_SDKS_093_BASELINE_WORDS = 84;
export const PROVIDERS_WORD_BUDGET_RATIO = 0.5;

export function makeTool(
  provider: CliToolStatus['provider'],
  label: string,
  binaryName: string,
  installed: boolean,
  version: string | null,
  overrides: Partial<CliToolStatus> = {},
): CliToolStatus {
  return {
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
    lastError: null,
    ...overrides,
  };
}

export const sdksFixture: SdkStatus[] = [
  {
    id: 'platformio',
    label: 'PlatformIO Core',
    description: 'Embedded C/C++ toolchain and board packages for ESP32, STM32 and AVR.',
    sizeHint: '~400 MB',
    installed: true,
    version: '6.1.16',
    installing: false,
    terminalId: null,
  },
  {
    id: 'android',
    label: 'Android SDK & JDK 21',
    description: 'Command-line tools, platform 35, build-tools and OpenJDK 21 for Gradle builds.',
    sizeHint: '~1.8 GB',
    installed: false,
    version: null,
    installing: false,
    terminalId: null,
  },
];

export function makeToolchain(overrides: Partial<ToolchainStatusResponse> = {}): ToolchainStatusResponse {
  return {
    toolsDir: '/opt/ai-tools',
    osInfo: 'Linux 6.8',
    nodeVersion: 'v22.12.0',
    autoInstallEnabled: true,
    tools: [
      makeTool('claude', 'Claude Code', 'claude', true, '1.0.21'),
      makeTool('antigravity', 'Antigravity', 'agy', true, '0.4.2'),
      makeTool('codex', 'Codex CLI', 'codex', false, null),
      makeTool('copilot', 'GitHub Copilot CLI', 'copilot', true, '1.2.3'),
      makeTool('aider', 'Aider', 'aider', true, '0.68.0'),
    ],
    sdks: sdksFixture,
    ...overrides,
  };
}

export const toolchainFixture: ToolchainStatusResponse = makeToolchain();

export function makeSettings(overrides: Partial<FactorySettings> = {}): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
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
      claude: {
        authenticated: true,
        method: 'oauth_cli',
        label: 'Claude Max 20x',
        cliInstalled: true,
        loginCommandHint: 'claude login',
      },
      antigravity: {
        authenticated: true,
        method: 'oauth_cli',
        label: 'Antigravity ready',
        cliInstalled: true,
        loginCommandHint: 'agy auth login',
      },
      codex: {
        authenticated: false,
        method: 'none',
        label: 'Not signed in',
        cliInstalled: false,
        loginCommandHint: 'codex login',
      },
      copilot: {
        authenticated: false,
        method: 'none',
        label: 'Not signed in',
        cliInstalled: true,
        loginCommandHint: 'copilot login',
      },
      aider: {
        authenticated: false,
        method: 'none',
        label: 'No API key',
        cliInstalled: true,
        loginCommandHint: '',
      },
    },
    ...overrides,
  });
}

function makeForm(settings: FactorySettings): ProviderSectionForm {
  const draft = providerDraftFrom(settings);
  return {
    settings,
    setSettings: () => undefined,
    defaultAgent: draft.defaultAgent,
    setDefaultAgent: () => undefined,
    enabledProviders: draft.enabledProviders,
    setEnabledProviders: () => undefined,
    antigravityAck: draft.antigravityAck,
    setAntigravityAck: () => undefined,
    personaRoutes: draft.personaRoutes,
    setPersonaRoutes: () => undefined,
    quotaPolicy: draft.quotaPolicy,
    setQuotaPolicy: () => undefined,
    apiKeys: draft.apiKeys,
    patchApiKeys: () => undefined,
    dirty: false,
    onDiscard: () => undefined,
    saving: false,
    onSave: () => undefined,
    setNotice: () => undefined,
    setError: () => undefined,
  };
}

beforeEach(() => {
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/toolchain/status': () => toolchainFixture,
      'GET /api/factory/claude-usage': () => ({ available: false, authenticated: false }),
      'GET /api/models': () => ({
        catalog: {
          claude: { models: [], read: null },
          antigravity: { models: [], read: null },
          codex: { models: [], read: null },
          copilot: { models: [], read: null },
          aider: { models: [], read: null },
        },
      }),
    }),
  );
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('AC-6.5 Providers tab density budget (at most 50% of 0.9.3 words)', () => {
  it('keeps the default Agents view at or under 50% of the 0.9.3 tab word count', async () => {
    const settings = makeSettings();
    const view = await renderDom(createElement(ProvidersSection, { form: makeForm(settings) }), {
      path: '/settings?tab=providers',
    });
    await waitFor(() => {
      expect(view.container.textContent).toContain('Claude Max 20x');
      expect(view.container.textContent).toContain('1.0.21');
    });

    const words = visibleWordCount(view.container);
    const tabBudget = Math.floor(PROVIDERS_TAB_093_BASELINE_WORDS * PROVIDERS_WORD_BUDGET_RATIO);
    const agentsBudget = Math.floor(PROVIDERS_AGENTS_093_BASELINE_WORDS * PROVIDERS_WORD_BUDGET_RATIO);
    expect(words).toBeGreaterThan(0);
    expect(words).toBeLessThanOrEqual(tabBudget);
    expect(words).toBeLessThanOrEqual(agentsBudget);

    // Runner details live inside the HelpHint popover
    expect(view.container.textContent).not.toContain('Linux 6.8');
    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="About the runner"]')!);
    expect(view.container.textContent).toContain('Linux 6.8');
    expect(view.container.textContent).toContain('/opt/ai-tools');
  });

  it('keeps the default Routing and SDKs views at or under 50% of their 0.9.3 word counts', async () => {
    const settings = makeSettings();
    const routing = await renderDom(
      createElement(RoutingView, { form: makeForm(settings), claudeUsage: undefined }),
    );
    const routingWords = visibleWordCount(routing.container);
    expect(routingWords).toBeLessThanOrEqual(
      Math.floor(PROVIDERS_ROUTING_093_BASELINE_WORDS * PROVIDERS_WORD_BUDGET_RATIO),
    );
    await routing.unmount();

    const sdks = await renderDom(
      createElement(SdkToolchainPanel, { sdks: sdksFixture, onChanged: () => undefined }),
    );
    const sdkWords = visibleWordCount(sdks.container);
    expect(sdkWords).toBeLessThanOrEqual(
      Math.floor(PROVIDERS_SDKS_093_BASELINE_WORDS * PROVIDERS_WORD_BUDGET_RATIO),
    );

    // SDK details and Uninstall are behind the Details disclosure
    expect(sdks.container.textContent).not.toContain('Embedded C/C++ toolchain');
    await click(getButton('Details', sdks.container));
    expect(sdks.container.textContent).toContain('Embedded C/C++ toolchain');
    expect(getButton('Uninstall', sdks.container)).toBeTruthy();
  });

  it('enforces token-only colours, >= 0.8rem font sizes, zero inline styles and < 450 lines across target files', () => {
    const css = readFileSync(resolve(HERE, 'components/settings/providers/providers.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/font-size:\s*[0-9.]+px/);
    const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const rem of fontSizes) {
      expect(rem).toBeGreaterThanOrEqual(0.8);
    }

    const targetComponentFiles = [
      'components/settings/ProvidersSection.tsx',
      'components/settings/ProviderCard.tsx',
      'components/settings/ProviderModels.tsx',
      'components/settings/PersonaRoutingSection.tsx',
      'components/settings/settingsMeta.ts',
      'components/settings/providers/AgentsView.tsx',
      'components/settings/providers/ProviderRow.tsx',
      'components/settings/providers/ProviderRowDetails.tsx',
      'components/settings/providers/RoutingView.tsx',
      'components/settings/providers/PersonaRouteRow.tsx',
      'components/settings/providers/PresetMenu.tsx',
      'components/SdkToolchainPanel.tsx',
      'components/RouteChainEditor.tsx',
    ];
    for (const rel of targetComponentFiles) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }

    for (const rel of [
      'components/settings/providers/providers.css',
      'providerKeys.test.ts',
      'providerModels.test.ts',
      'removedAgent.test.ts',
      'providersView.test.ts',
      'providersDensity.test.ts',
    ]) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }
  });
});
