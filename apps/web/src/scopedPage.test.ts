import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ScopedPage } from './components/ScopedPage';
import { pageScope, resolveActiveProject, SERVER_CHOICE_WAIT_MS } from './projectPaths';
import { renderStatic } from './staticRender';

describe('pageScope (E-T12-1)', () => {
  it('waits while the active project is being resolved, not "All projects"', () => {
    expect(pageScope(undefined, false)).toBeUndefined();
    expect(pageScope('p1', false)).toBe('p1');
    expect(pageScope(null, false)).toBeNull();
  });

  it('a server choice that did not come in time resolves like a failed one, so the pages mount', () => {
    const c = { fromUrl: null, stored: null, server: undefined };
    expect(
      pageScope(resolveActiveProject(['a', 'b'], { ...c, serverFailed: false }).id, false),
    ).toBeUndefined();
    // App marks the read failed after SERVER_CHOICE_WAIT_MS without an answer (withTimeout).
    expect(pageScope(resolveActiveProject(['a', 'b'], { ...c, serverFailed: true }).id, false)).toBe('a');
    expect(SERVER_CHOICE_WAIT_MS).toBeLessThanOrEqual(10_000);
  });

  it('falls back to all projects when the project list could not be loaded', () => {
    expect(pageScope(undefined, true)).toBeNull();
    expect(pageScope('p1', true)).toBe('p1');
  });
});

describe('ScopedPage (E-T12-1)', () => {
  it('shows a pending state and does not mount the page while the scope is pending', () => {
    const page = vi.fn(() => createElement('p', null, 'page'));
    const html = renderStatic(
      createElement(ScopedPage, { scope: undefined, pendingClassName: 'inbox-page', children: page }),
    );
    expect(html).toBe('<div class="inbox-page" aria-busy="true"></div>');
    expect(page).not.toHaveBeenCalled();
  });

  it('mounts the page with the project, or with null for all projects', () => {
    for (const scope of ['p1', null]) {
      const page = vi.fn((id: string | null) => createElement('p', null, `page ${id ?? 'all'}`));
      const html = renderStatic(
        createElement(ScopedPage, { scope, pendingClassName: 'inbox-page', children: page }),
      );
      expect(html).toBe(`<p>page ${scope ?? 'all'}</p>`);
      expect(page).toHaveBeenCalledWith(scope);
    }
  });
});
