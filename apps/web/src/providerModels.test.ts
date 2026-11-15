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
import { LiveEvents } from './hooks/liveData';
import type * as EventHubModule from './hooks/eventHub';
import type { ServerEvent } from '@emberline/protocol';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

/** The events socket, replaced by a hook that hands each pushed event to the subscribers. */
const pushed = vi.hoisted(() => ({ listeners: new Set<{ onEvent: (e: unknown) => void }>() }));
vi.mock('./hooks/eventHub', async (importOriginal) => ({
  ...(await importOriginal<typeof EventHubModule>()),
  subscribeEvents: (listener: { onEvent: (e: unknown) => void }) => {
    pushed.listeners.add(listener);
    return () => pushed.listeners.delete(listener);
  },
}));
const push = (event: ServerEvent) => pushed.listeners.forEach((l) => l.onEvent(event));

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
    ['claude', 'antigravity', 'copilot', 'codex', 'aider'].map((a) => [a, { models: [], read: null }]),
  ) as unknown as StoredCatalog;

let catalog: StoredCatalog;
let posts: { path: string; body: unknown }[];
/** What the next Refresh models answers; a promise to hold the request open. */
let refreshAnswer: unknown;

beforeEach(() => {
  setModelCatalog(null);
  posts = [];
  refreshAnswer = { reads: {}, skipped: {} };
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
        return refreshAnswer;
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
    createElement(LiveEvents, { key: 'live' }),
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

  it('shows that a read is under way, then whether it was read, failed or skipped and why', async () => {
    const { container } = await renderDom(createElement(Harness));
    await waitFor(() => expect(container.textContent).toContain('GPT 9 Preview'));
    let answer!: (value: unknown) => void;
    refreshAnswer = new Promise((resolve) => (answer = resolve));
    await click(getButton('Refresh models', container));
    await waitFor(() => expect(container.textContent).toContain('Reading models…'));
    expect(container.textContent).toContain('this can take up to a minute');
    expect(getButton('Reading models…', container).disabled).toBe(true);
    answer({ reads: {}, skipped: { copilot: 'not_installed' } });
    await waitFor(() => expect(container.textContent).toContain('Not read: its CLI is not installed.'));
    expect(container.textContent).not.toContain('Reading models…');

    refreshAnswer = { reads: {}, skipped: { copilot: 'not_signed_in' } };
    await click(getButton('Refresh models', container));
    await waitFor(() => expect(container.textContent).toContain('Not read: its CLI is not signed in.'));

    refreshAnswer = {
      reads: { copilot: { at: AT, cliVersion: '1.2.3', ok: true, error: null } },
      skipped: {},
    };
    await click(getButton('Refresh models', container));
    await waitFor(() => expect(container.textContent).toContain('Read just now.'));

    refreshAnswer = {
      reads: { copilot: { at: AT, cliVersion: '1.2.3', ok: false, error: 'Copilot refused session/new' } },
      skipped: {},
    };
    await click(getButton('Refresh models', container));
    await waitFor(() =>
      expect(container.textContent).toContain('The read failed: Copilot refused session/new'),
    );
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

  it('lists the models a read in the background found, once core says the catalog changed', async () => {
    const { container } = await renderDom(createElement(Harness));
    await waitFor(() => expect(container.textContent).toContain('GPT 9 Preview'));
    const picker = () =>
      [...container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.options].map(
        (o) => o.value,
      );
    catalog.copilot.models.push(model('gpt-10-luna', { label: 'GPT 10 Luna' }));
    expect(container.textContent).not.toContain('GPT 10 Luna');

    push({ type: 'models' });
    await waitFor(() => expect(container.textContent).toContain('GPT 10 Luna'));
    await waitFor(() => expect(picker()).toContain('gpt-10-luna'));
  });
});
