// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setModelCatalog } from '@emberline/protocol';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { ProviderModels } from './components/settings/ProviderModels';
import { RouteChainEditor } from './components/RouteChainEditor';
import { useModelCatalog, type StoredCatalog, type StoredModel } from './modelCatalog';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const AT = '2026-11-14T10:00:00.000Z';
const model = (id: string, over: Partial<StoredModel> = {}): StoredModel => ({
  id,
  label: id.toUpperCase(),
  shortLabel: id,
  rank: 4,
  tier: 'high',
  badge: 'discovered',
  capabilities: [],
  description: '',
  source: 'cli',
  missingSince: null,
  firstSeen: AT,
  lastSeen: AT,
  ...over,
});
const empty = (): StoredCatalog =>
  Object.fromEntries(
    ['claude', 'antigravity', 'copilot', 'gemini', 'codex', 'aider'].map((a) => [
      a,
      { models: [], read: null },
    ]),
  ) as unknown as StoredCatalog;

let catalog: StoredCatalog;
let posts: { path: string; body: unknown }[];

beforeEach(() => {
  setModelCatalog(null);
  posts = [];
  catalog = empty();
  catalog.copilot = {
    models: [model('gpt-9-preview', { label: 'GPT 9 Preview' }), model('old-one', { missingSince: AT })],
    read: { at: AT, cliVersion: '1.2.3', ok: false, error: 'the picker did not open' },
  };
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/models': () => ({ catalog: structuredClone(catalog) }),
      'POST /api/models/refresh': (body) => {
        posts.push({ path: 'refresh', body });
        return { reads: {} };
      },
      'POST /api/models/copilot/manual': (body) => {
        posts.push({ path: 'manual', body });
        catalog.copilot.models.push(
          model((body as { id: string }).id, {
            source: 'manual',
            badge: '',
            label: (body as { id: string }).id,
          }),
        );
        return { catalog };
      },
      'DELETE /api/models/copilot/manual/mine-1': () => {
        posts.push({ path: 'delete', body: null });
        catalog.copilot.models = catalog.copilot.models.filter((m) => m.id !== 'mine-1');
        return { catalog };
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  setModelCatalog(null);
});

function Harness() {
  useModelCatalog();
  return createElement('div', null, [
    createElement(ProviderModels, { key: 'm', providerId: 'copilot' }),
    createElement(RouteChainEditor, {
      key: 'r',
      persona: 'coder',
      value: [{ agent: 'copilot', model: 'auto', credential: 'login' }],
      onChange: () => undefined,
      enabledProviders: ['copilot'],
      keyConfigured: {},
    } as never),
  ]);
}

describe('a provider card lists its models', () => {
  it('shows a discovered model, when it went missing and the last read error', async () => {
    const { container } = await renderDom(createElement(Harness));
    await waitFor(() => expect(container.textContent).toContain('GPT 9 Preview'));
    expect(container.textContent).toContain('gpt-9-preview');
    expect(container.textContent).toContain('missing since');
    expect(container.textContent).toContain('1.2.3');
    expect(container.textContent).toContain('the picker did not open');
  });

  it('Refresh models posts for this provider', async () => {
    const { container } = await renderDom(createElement(Harness));
    await waitFor(() => expect(container.textContent).toContain('GPT 9 Preview'));
    await click(getButton('Refresh models', container));
    await waitFor(() => expect(posts).toEqual([{ path: 'refresh', body: { agent: 'copilot' } }]));
  });

  it('Add a model id posts the typed id, and the id shows up in a route picker', async () => {
    const { container } = await renderDom(createElement(Harness));
    await waitFor(() => expect(container.textContent).toContain('GPT 9 Preview'));
    const picker = () => container.querySelector('select[aria-label="Model"]')!.textContent ?? '';
    expect(picker()).not.toContain('mine-1');

    const input = container.querySelector('input[aria-label="Model id"]') as HTMLInputElement;
    await typeInto(input, 'mine-1');
    await click(getButton('Add a model id', container));
    await waitFor(() => expect(posts).toEqual([{ path: 'manual', body: { id: 'mine-1' } }]));
    await waitFor(() => expect(picker()).toContain('mine-1'));

    await click(container.querySelector('button[aria-label="Remove mine-1"]')!);
    await waitFor(() => expect(posts.at(-1)?.path).toBe('delete'));
    await waitFor(() => expect(picker()).not.toContain('mine-1'));
  });
});
