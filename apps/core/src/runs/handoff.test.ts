import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt, summarizeRecentTools } from './handoff.js';

const base = {
  ticket: { key: 'MPG-28', title: 'Accessibility pass', body: 'Colour-blind safe cats.' },
  originalPrompt: 'MPG-28: Accessibility pass\n\nColour-blind safe cats.',
  from: { agent: 'antigravity', model: 'argon' },
  reason: 'Individual quota reached. Resets in 31h43m5s.',
  finalMessage: null,
  gitStatus: ' M src/ui/level-select.ts\n M src/ui/result-dialog.ts',
  diffStat: ' 2 files changed, 40 insertions(+), 3 deletions(-)',
  recentTools: ['replace_file_content: src/ui/level-select.ts', 'replace_file_content: src/ui/result-dialog.ts'],
  sameAgent: false,
};

describe('handoff prompt', () => {
  it('tells the next agent what the previous one did and why it stopped', () => {
    const text = buildHandoffPrompt(base);
    expect(text).toContain('MPG-28: Accessibility pass');
    expect(text).toContain('Colour-blind safe cats.');
    expect(text).toContain('antigravity (argon)');
    expect(text).toContain('Individual quota reached');
    expect(text).toContain('M src/ui/level-select.ts');
    expect(text).toContain('2 files changed');
    expect(text).toContain('replace_file_content: src/ui/result-dialog.ts');
    expect(text).toMatch(/do not redo/i);
  });

  it('says so when the tree is clean and leaves out empty sections', () => {
    const text = buildHandoffPrompt({ ...base, gitStatus: '', diffStat: '', recentTools: [], finalMessage: 'Plan: 1) tokens 2) aria' });
    expect(text).toContain('No changes in the worktree yet.');
    expect(text).not.toContain('Recent tool calls');
    expect(text).toContain('Plan: 1) tokens 2) aria');
  });

  it('uses the original prompt when the run has no ticket', () => {
    expect(buildHandoffPrompt({ ...base, ticket: null })).toContain('MPG-28: Accessibility pass\n\nColour-blind safe cats.');
  });
});

describe('recent tool summary', () => {
  it('collapses consecutive repeats and whitespace in details', () => {
    const out = summarizeRecentTools([
      { name: 'Edit', detail: '' },
      { name: 'Edit', detail: '' },
      { name: 'Bash', detail: 'npm\n  test\t-- run' },
      { name: 'Edit', detail: '' },
    ]);
    expect(out).toEqual(['Edit ×2', 'Bash: npm test -- run', 'Edit']);
  });

  it('is empty when no entry has a detail', () => {
    expect(summarizeRecentTools([{ name: 'Edit', detail: '' }, { name: 'Write', detail: '' }])).toEqual([]);
  });
});
