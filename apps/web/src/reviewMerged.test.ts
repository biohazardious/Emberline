// @vitest-environment happy-dom
import type { RunDiffSummary } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderDom } from './domRender';
import { MergeGateBanner } from './components/review/MergeGateBanner';
import { type MergeGateSummary, mergedWithNothingLeft } from './reviewGate';

afterEach(cleanup);

const summary = (files: number) =>
  ({
    isGitRepo: true,
    files: Array.from({ length: files }, (_, i) => ({ path: `f${i}` })),
  }) as unknown as RunDiffSummary;

describe('a merged run on its review page', () => {
  it('is merged with nothing left only when the branch has nothing main lacks', () => {
    expect(mergedWithNothingLeft(true, summary(0))).toBe(true);
    // A later turn wrote more after the merge: the gate is back.
    expect(mergedWithNothingLeft(true, summary(2))).toBe(false);
    expect(mergedWithNothingLeft(false, summary(0))).toBe(false);
    expect(mergedWithNothingLeft(true, undefined)).toBe(false);
  });

  it('says "Merged into main" instead of "Merge gate ready"', async () => {
    const gate = { loaded: true, isBlocked: false } as MergeGateSummary;
    const props = { gate, onJumpToComment: () => undefined, onVerifyCarried: () => undefined };
    const merged = await renderDom(createElement(MergeGateBanner, { ...props, merged: true }));
    expect(merged.container.textContent).toContain('Merged into main');
    expect(merged.container.textContent).toContain('nothing left to merge');
    expect(merged.container.textContent).not.toContain('Merge gate ready');
    await cleanup();
    const open = await renderDom(createElement(MergeGateBanner, props));
    expect(open.container.textContent).toContain('Merge gate ready');
  });
});
