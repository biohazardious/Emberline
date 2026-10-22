import type { Run } from '@emberline/protocol';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RunFailureBanner } from './components/RunInspector';
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
