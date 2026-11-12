import type { Run, RunRecovery } from '@emberline/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ComponentProps, createElement } from 'react';
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

const render = (data: RunRecovery, props: Partial<ComponentProps<typeof HoldRecovery>> = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['run-recovery', 'r1'], data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Router, { ssrPath: '/', children: createElement(HoldRecovery, { run, ...props }) }),
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
  it("drops the hold's label only where the caller says it shows it already", () => {
    const onAnswer = () => undefined;
    expect(render(rec('session'))).toContain('<strong>Merge failed</strong>');
    expect(render(rec('session'), { onAnswer })).toContain('<strong>Merge failed</strong>');
    expect(render(rec('session'), { onAnswer, hideLabel: true })).not.toContain('Merge failed');
  });
  it('keeps the Copy fallback when the run cannot take a prompt', () => {
    expect(render(rec('none'))).toContain('Copy: Rebase it');
  });

  it('links wait_for_agent and wait_for_resolver suggestions to the resolving run review', () => {
    const agentRec: RunRecovery = {
      hold: 'merge_failed',
      label: 'Merge failed',
      why: '2 files conflict with main; the agent is resolving it now',
      delivery: 'session',
      suggestions: [
        {
          id: 'wait_for_agent',
          kind: 'manual',
          label: 'Wait for the agent',
          detail: 'It was asked to merge main and resolve the conflicts.',
          prompt: null,
          files: [],
          commands: [],
        },
      ],
    };
    const agentHtml = render(agentRec);
    expect(agentHtml).toContain('href="/runs/r1/review"');
    expect(agentHtml).toContain('>Wait for the agent</a>');

    const resolverRec: RunRecovery = {
      ...agentRec,
      suggestions: [
        {
          id: 'wait_for_resolver',
          kind: 'manual',
          label: 'Wait for resolver run r-succ-9',
          detail: 'It merges main into the branch.',
          prompt: null,
          files: [],
          commands: [],
        },
      ],
    };
    const resolverHtml = render(resolverRec, {
      run: { ...run, handedOffTo: 'r-succ-99' } as unknown as Run,
    });
    expect(resolverHtml).toContain('href="/runs/r-succ-99/review"');
    expect(resolverHtml).toContain('>Wait for resolver run r-succ-9</a>');
  });
});
