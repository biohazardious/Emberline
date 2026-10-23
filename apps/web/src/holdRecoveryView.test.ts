import type { Run, RunRecovery } from '@emberline/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { describe, expect, it } from 'vitest';
import { HoldRecovery } from './components/HoldRecovery';

const run = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  attention: { reason: 'held', detail: null, since: '2026-10-18T11:59:00.000Z', occurrence: 'r1:held:e1' },
} as unknown as Run;

const rec = (delivery: RunRecovery['delivery']): RunRecovery => ({
  hold: 'merge_failed',
  label: 'Merge failed',
  why: 'main moved',
  delivery,
  suggestions: [
    {
      id: 'rebase',
      kind: 'prompt',
      label: 'Rebase it',
      detail: null,
      prompt: 'rebase',
      files: [],
      commands: [],
    },
  ],
});

const render = (data: RunRecovery) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['run-recovery', 'r1'], data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Router, { ssrPath: '/', children: createElement(HoldRecovery, { run }) }),
    ),
  );
};

describe('HoldRecovery', () => {
  it('shows a prompt suggestion as a button with no inline editor', () => {
    const html = render(rec('session'));
    expect(html).toContain('>Rebase it</button>');
    expect(html).not.toContain('hold-recovery-form');
    expect(html).not.toContain('<textarea');
  });
  it('keeps the Copy fallback when the run cannot take a prompt', () => {
    expect(render(rec('none'))).toContain('Copy: Rebase it');
  });
});
