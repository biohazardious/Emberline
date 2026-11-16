// @vitest-environment happy-dom
import type { AgentId, FactorySettings } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { ProviderRow } from './components/settings/providers/ProviderRow';
import type { ProviderSectionForm } from './components/settings/settingsMeta';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

let patches: unknown[];
let shown: FactorySettings | null;
let notice: string | null;

beforeEach(() => {
  patches = [];
  shown = null;
  notice = null;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/models': () => ({ catalog: {} }),
      'PATCH /api/factory/settings': (body) => {
        patches.push(body);
        return { ...settings(true), geminiKeyStored: false, geminiKeyConfigured: false };
      },
    }),
  );
});
afterEach(cleanup);

const settings = (stored: boolean) =>
  ({
    geminiKeyStored: stored,
    geminiKeyConfigured: stored,
    providerAuth: {},
  }) as unknown as FactorySettings;

const row = (enabled: AgentId[], stored: boolean) =>
  createElement(ProviderRow, {
    providerId: 'aider',
    form: {
      settings: settings(stored),
      setSettings: (next: FactorySettings) => (shown = next),
      enabledProviders: enabled,
      antigravityAck: false,
      setAntigravityAck: () => undefined,
      apiKeys: { anthropic: '', openai: '', gemini: '' },
      patchApiKeys: () => undefined,
      setNotice: (next: string | null) => (notice = next),
      setError: () => undefined,
    } as unknown as ProviderSectionForm,
    settings: settings(stored),
    toolStatus: undefined,
    busyToolProvider: null,
    updatingAllTools: false,
    launchingLoginProvider: null,
    onToggleEnabled: () => undefined,
    onToolchainAction: () => undefined,
    onStartLogin: () => undefined,
  });

describe('the Gemini API key on the Aider row', () => {
  it('shows Key stored on the collapsed row even with Aider off, and Remove key in details clears it', async () => {
    const { container } = await renderDom(row(['claude'], true));
    expect(container.textContent).toContain('Key stored');
    expect(container.textContent).not.toContain('Google Gemini API Key');

    const expandBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    await click(expandBtn);
    expect(container.textContent).toContain('Google Gemini API Key');

    await click(getButton(/Remove key/, container));
    await waitFor(() => expect(patches).toEqual([{ geminiApiKey: null }]));
    expect(shown?.geminiKeyStored).toBe(false);
    expect(notice).toBe('Gemini API key removed.');
  });

  it('with Aider off and no key stored, shows neither Key stored nor the key field', async () => {
    const { container } = await renderDom(row(['claude'], false));
    expect(container.textContent).not.toContain('Key stored');
    const expandBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    await click(expandBtn);
    expect(container.textContent).not.toContain('Google Gemini API Key');
  });

  it('with Aider on and no key stored, shows the field when expanded without Remove key', async () => {
    const { container } = await renderDom(row(['claude', 'aider'], false));
    expect(container.textContent).not.toContain('Key stored');
    const expandBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    await click(expandBtn);
    expect(container.textContent).toContain('Google Gemini API Key');
    expect(container.textContent).not.toContain('Remove key');
  });
});
