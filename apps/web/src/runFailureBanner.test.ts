import type { Run } from '@emberline/protocol';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { failureFetchNeeded, RunFailureBanner } from './components/RunInspector';
import { renderStatic } from './staticRender';

const run = (over: Partial<Run>) =>
  ({
    id: 'r1',
    agent: 'claude',
    state: 'failed',
    cancelled: false,
    stateChangedAt: '2026-10-22T00:00:00Z',
    ...over,
  }) as Run;

describe('RunFailureBanner', () => {
  it('shows the failure of a run that failed by itself', () => {
    expect(renderStatic(createElement(RunFailureBanner, { run: run({}) }))).toContain('run-failure-banner');
  });

  it('shows nothing for a run the person stopped (failed + cancelled)', () => {
    expect(renderStatic(createElement(RunFailureBanner, { run: run({ cancelled: true }) }))).toBe('');
  });
});

describe('failureFetchNeeded', () => {
  it('fetches the events of a run that failed by itself', () => {
    expect(failureFetchNeeded(run({}))).toBe(true);
  });

  it('skips the fetch for a run the person stopped, and for a run that did not fail', () => {
    expect(failureFetchNeeded(run({ cancelled: true }))).toBe(false);
    expect(failureFetchNeeded(run({ state: 'working' }))).toBe(false);
    expect(failureFetchNeeded(run({ state: 'done' }))).toBe(false);
  });
});
