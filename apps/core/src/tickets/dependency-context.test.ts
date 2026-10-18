import { describe, expect, it } from 'vitest';
import { DEPENDENCY_BLOCK_MAX, dependencyContextSection } from './dependency-context.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('dependencyContextSection clipping', () => {
  it('never splits a character when it shortens a block', () => {
    const section = dependencyContextSection([
      { key: 'A-1', title: 'T', completion: { summary: '😀'.repeat(2_000), handoff: '', at: '2026-10-18T00:00:00.000Z' } },
    ]);
    const block = section.split('\n\n')[1]!;
    expect(block.length).toBeLessThanOrEqual(DEPENDENCY_BLOCK_MAX);
    expect(block.endsWith('…')).toBe(true);
    expect(section).not.toMatch(loneSurrogate);
  });
});
