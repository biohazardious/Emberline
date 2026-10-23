import type { Run, RunRecovery } from '@emberline/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoldRecovery } from './components/HoldRecovery';
import { InboxPage } from './pages/InboxPage';

// The static render cannot click, so a test opens the Answer dialog by its host's state.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return { ...react, useState: vi.fn(react.useState) };
});
// The real dialog renders into document.body, which the node test run has none of.
const dialogProps = vi.hoisted(() => ({ current: null as null | { onSent?: () => void } }));
vi.mock('./components/AnswerDialog', () => ({
  AnswerDialog: (props: { onSent?: () => void }) => {
    dialogProps.current = props;
    return 'ANSWER-DIALOG';
  },
}));

const held = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  attention: { reason: 'held', detail: null, since: '2026-10-18T11:59:00.000Z', occurrence: 'r1:held:e1' },
} as unknown as Run;

const rec: RunRecovery = {
  hold: 'merge_failed',
  label: 'Merge failed',
  why: 'main moved',
  delivery: 'session',
  suggestions: [],
};

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const html = (client: QueryClient, element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Router, { ssrPath: '/', children: element }),
    ),
  );

/** HoldRecovery with its Answer dialog open, the recovery query holding `data`. */
function renderOpen(run: Run, data: RunRecovery | null) {
  // The first state in HoldRecovery is the open dialog's start text.
  vi.mocked(useState).mockImplementationOnce(() => ['', () => undefined]);
  const client = newClient();
  client.setQueryData(['run-recovery', 'r1'], data);
  return { html: html(client, createElement(HoldRecovery, { run })), client };
}

afterEach(() => {
  dialogProps.current = null;
});

describe('HoldRecovery Answer dialog', () => {
  it('is shown with the block', () => {
    const { html } = renderOpen(held, rec);
    expect(html).toContain('Merge failed');
    expect(html).toContain('ANSWER-DIALOG');
  });
  it('outlives the block: a refetch that ends the hold keeps it and the files in it', () => {
    const gone = renderOpen(held, null).html;
    expect(gone).not.toContain('Merge failed');
    expect(gone).toContain('ANSWER-DIALOG');
    const working = renderOpen({ ...held, attention: null } as Run, rec).html;
    expect(working).not.toContain('Merge failed');
    expect(working).toContain('ANSWER-DIALOG');
  });
  it('once sent, refetches the recovery and drops the answered question', () => {
    const { client } = renderOpen(held, rec);
    client.setQueryData(['run-question', 'r1', 'r1:held:e1'], { text: 'Why?' });
    dialogProps.current?.onSent?.();
    expect(client.getQueryState(['run-recovery', 'r1'])?.isInvalidated).toBe(true);
    expect(client.getQueryData(['run-question', 'r1', 'r1:held:e1'])).toBeUndefined();
  });
});

describe('Inbox Answer dialog', () => {
  it('once sent, refetches the recovery and drops the answered question', async () => {
    const real = (await vi.importActual<typeof React>('react')).useState;
    // The Inbox's open dialog is its only state that starts as null.
    vi.mocked(useState).mockImplementation(((init: unknown) =>
      init === null
        ? [{ run: held, heading: { key: null, title: 'Fix it' }, text: '' }, () => undefined]
        : real(init)) as typeof useState);
    const client = newClient();
    client.setQueryData(['run-recovery', 'r1'], rec);
    client.setQueryData(['run-question', 'r1', 'r1:held:e1'], { text: 'Why?' });
    try {
      const page = html(
        client,
        createElement(InboxPage, {
          runs: [held],
          seen: {},
          activeProjectId: null,
          onOpenRun: () => undefined,
          onDismiss: () => undefined,
        }),
      );
      expect(page).toContain('ANSWER-DIALOG');
    } finally {
      vi.mocked(useState).mockImplementation(real);
    }
    dialogProps.current?.onSent?.();
    expect(client.getQueryState(['run-recovery', 'r1'])?.isInvalidated).toBe(true);
    expect(client.getQueryData(['run-question', 'r1', 'r1:held:e1'])).toBeUndefined();
  });
});
