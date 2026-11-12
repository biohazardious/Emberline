// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, ViewErrorBanner, ViewLoadingState } from './components/ErrorBoundary';
import { cleanup, click, getButton, renderDom, waitFor } from './domRender';

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary and async view primitives', () => {
  it('isolates rendering crashes, displays alert details, and recovers on Try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let shouldThrow = true;

    function FragileView() {
      if (shouldThrow) throw new Error('Kanban column invariant failed');
      return createElement('p', null, 'Board recovered cleanly');
    }

    let resets = 0;
    await renderDom(
      createElement(ErrorBoundary, {
        title: 'Board view crashed',
        onReset: () => {
          resets += 1;
        },
        children: createElement(FragileView),
      }),
    );

    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Board view crashed');
    expect(alert?.textContent).toContain('Kanban column invariant failed');

    shouldThrow = false;
    await click(getButton(/Try again/));
    await waitFor(() => expect(document.body.textContent).toContain('Board recovered cleanly'));
    expect(resets).toBe(1);
  });

  it('clears a caught error automatically when resetKey changes (route navigation)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function RouteView({ broken }: { broken: boolean }) {
      if (broken) throw new Error('Failed to fetch dynamically imported module: /assets/FleetPage.js');
      return createElement('div', null, 'Healthy route content');
    }

    const { rerender } = await renderDom(
      createElement(ErrorBoundary, {
        resetKey: '/fleet',
        children: createElement(RouteView, { broken: true }),
      }),
    );

    expect(document.body.textContent).toContain('Could not load this view bundle');

    await rerender(
      createElement(ErrorBoundary, {
        resetKey: '/inbox',
        children: createElement(RouteView, { broken: false }),
      }),
    );
    expect(document.body.textContent).toContain('Healthy route content');
  });

  it('renders ViewErrorBanner with Retry callback and ViewLoadingState semantics', async () => {
    let retries = 0;
    await renderDom(
      createElement(
        'div',
        null,
        createElement(ViewErrorBanner, {
          label: 'Could not load board tickets',
          error: new Error('503 Gateway Timeout'),
          onRetry: () => {
            retries += 1;
          },
        }),
        createElement(ViewLoadingState, { label: 'Loading project tickets…' }),
      ),
    );

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load board tickets: 503 Gateway Timeout',
    );
    expect(document.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain(
      'Loading project tickets…',
    );

    await click(getButton(/Retry/));
    expect(retries).toBe(1);
  });
});
