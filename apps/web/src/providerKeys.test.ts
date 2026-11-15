// @vitest-environment happy-dom
import type { AgentId, FactorySettings } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { ProviderCard } from './components/settings/ProviderCard';
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

const card = (enabled: AgentId[], stored: boolean) =>
  createElement(ProviderCard, {
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

describe('the Gemini API key on the Aider card', () => {
  it('shows a stored key even with Aider off, and Remove key clears it', async () => {
    const { container } = await renderDom(card(['claude'], true));
    expect(container.textContent).toContain('Google Gemini API Key');
    await click(getButton(/Remove key/, container));
    await waitFor(() => expect(patches).toEqual([{ geminiApiKey: null }]));
    expect(shown?.geminiKeyStored).toBe(false);
    expect(notice).toBe('Gemini API key removed.');
  });

  it('with Aider off and no key stored, shows no key field', async () => {
    const { container } = await renderDom(card(['claude'], false));
    expect(container.textContent).not.toContain('Google Gemini API Key');
  });

  it('with Aider on and no key stored, shows the field without Remove key', async () => {
    const { container } = await renderDom(card(['claude', 'aider'], false));
    expect(container.textContent).toContain('Google Gemini API Key');
    expect(container.textContent).not.toContain('Remove key');
  });
});
