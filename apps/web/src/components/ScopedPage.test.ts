// @vitest-environment happy-dom
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderDom, typeInto } from '../domRender';
import { ScopedPage } from './ScopedPage';

/** A page with a draft of its own: local state, lost when it unmounts. */
function Page({ projectId }: { projectId: string | null }) {
  const [draft, setDraft] = useState('');
  return createElement(
    'div',
    null,
    createElement('p', { className: 'test-page' }, `page of ${projectId ?? 'all projects'}`),
    createElement('textarea', {
      'aria-label': 'Draft',
      value: draft,
      onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    }),
  );
}
const scoped = (scope: string | null | undefined) =>
  createElement(ScopedPage, {
    scope,
    pendingClassName: 'pending',
    children: (id: string | null) => createElement(Page, { projectId: id }),
  });
const draft = () => document.body.querySelector<HTMLTextAreaElement>('textarea')?.value ?? null;
const pending = () => document.body.querySelector('.pending[aria-busy="true"]') !== null;
const type = (text: string) => typeInto(document.body.querySelector('textarea')!, text);

afterEach(cleanup);

describe('ScopedPage', () => {
  it('keeps the page and its draft while the scope stays the same', async () => {
    const shown = await renderDom(scoped('a'));
    await type('note');
    await shown.rerender(scoped('a'));
    expect(draft()).toBe('note');
  });

  it('starts afresh for another scope: another project, or all projects', async () => {
    const shown = await renderDom(scoped('a'));
    await type('note for a');
    await shown.rerender(scoped('b'));
    expect(document.body.textContent).toContain('page of b');
    expect(draft()).toBe('');
    await type('note for b');
    await shown.rerender(scoped(null));
    expect(document.body.textContent).toContain('page of all projects');
    expect(draft()).toBe('');
  });

  it('waits, without the page, while the scope is resolved (a first visit, a deleted project)', async () => {
    const shown = await renderDom(scoped(undefined));
    expect(pending()).toBe(true);
    await shown.rerender(scoped('a'));
    await type('note');
    await shown.rerender(scoped(undefined));
    expect(pending()).toBe(true);
    expect(draft()).toBeNull();
  });
});
