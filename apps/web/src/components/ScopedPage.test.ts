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
const scoped = (scope: string | null | undefined, projectIds: string[] | undefined) =>
  createElement(ScopedPage, {
    scope,
    projectIds,
    pendingClassName: 'pending',
    children: (id: string | null) => createElement(Page, { projectId: id }),
  });
const draft = () => document.body.querySelector<HTMLTextAreaElement>('textarea')?.value ?? null;
const pending = () => document.body.querySelector('.pending[aria-busy="true"]') !== null;

afterEach(cleanup);

describe('ScopedPage', () => {
  it('keeps the page and its draft while the same project is resolved again', async () => {
    const shown = await renderDom(scoped('a', ['a', 'b']));
    await typeInto(document.body.querySelector('textarea')!, 'note');
    await shown.rerender(scoped(undefined, ['a', 'b']));
    expect(pending()).toBe(false);
    expect(draft()).toBe('note');
    await shown.rerender(scoped('a', ['a', 'b']));
    expect(draft()).toBe('note');
  });

  it('starts afresh for another project, after a transient state or straight away', async () => {
    const shown = await renderDom(scoped('a', ['a', 'b']));
    await typeInto(document.body.querySelector('textarea')!, 'note for a');
    await shown.rerender(scoped('b', ['a', 'b']));
    expect(document.body.textContent).toContain('page of b');
    expect(draft()).toBe('');
    await typeInto(document.body.querySelector('textarea')!, 'note for b');
    await shown.rerender(scoped(undefined, ['a', 'b']));
    await shown.rerender(scoped(null, undefined));
    expect(document.body.textContent).toContain('page of all projects');
    expect(draft()).toBe('');
  });

  it("never keeps a deleted project's page: it waits again", async () => {
    const shown = await renderDom(scoped('a', ['a', 'b']));
    await shown.rerender(scoped(undefined, ['b']));
    expect(pending()).toBe(true);
    expect(draft()).toBeNull();
  });

  it('waits on a first visit', async () => {
    await renderDom(scoped(undefined, ['a']));
    expect(pending()).toBe(true);
  });
});
