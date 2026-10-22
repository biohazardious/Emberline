import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt, successorPrompt, summarizeRecentTools } from './handoff.js';

const base = {
  ticket: { key: 'MPG-28', title: 'Accessibility pass', body: 'Colour-blind safe cats.' },
  originalPrompt: 'MPG-28: Accessibility pass\n\nColour-blind safe cats.',
  from: { agent: 'antigravity', model: 'argon' },
  reason: 'Individual quota reached. Resets in 31h43m5s.',
  finalMessage: null,
  gitStatus: ' M src/ui/level-select.ts\n M src/ui/result-dialog.ts',
  diffStat: ' 2 files changed, 40 insertions(+), 3 deletions(-)',
  recentTools: [
    'replace_file_content: src/ui/level-select.ts',
    'replace_file_content: src/ui/result-dialog.ts',
  ],
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
    const text = buildHandoffPrompt({
      ...base,
      gitStatus: '',
      diffStat: '',
      recentTools: [],
      finalMessage: 'Plan: 1) tokens 2) aria',
    });
    expect(text).toContain('No changes in the worktree yet.');
    expect(text).not.toContain('Recent tool calls');
    expect(text).toContain('Plan: 1) tokens 2) aria');
  });

  it('uses the original prompt when the run has no ticket', () => {
    expect(buildHandoffPrompt({ ...base, ticket: null })).toContain(
      'MPG-28: Accessibility pass\n\nColour-blind safe cats.',
    );
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
    expect(
      summarizeRecentTools([
        { name: 'Edit', detail: '' },
        { name: 'Write', detail: '' },
      ]),
    ).toEqual([]);
  });
});

describe('successor prompt', () => {
  const CLOSING =
    'Check the current state of the files first, keep the work that is already done, do not redo finished steps, and complete the task.';

  it("keeps the person's text whole and shortens the context to fit the run prompt limit", () => {
    const text = successorPrompt(
      { ...base, ticket: { ...base.ticket, body: 'c'.repeat(15_000) } },
      'x'.repeat(10_000),
    );
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text.endsWith(`\n\n${'x'.repeat(10_000)}`)).toBe(true);
    expect(text.startsWith('You are taking over a task')).toBe(true);
  });

  it('shortens the task and the last message first: the worktree state, the tool calls and the closing instruction stay', () => {
    const input = {
      ...base,
      ticket: { ...base.ticket, body: 'b'.repeat(6_000) },
      finalMessage: 'm'.repeat(6_000),
      gitStatus: ' M src/ui/level-select.ts\n?? notes/plan.md',
    };
    const extra = 'x'.repeat(15_000);
    const text = successorPrompt(input, extra);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text.endsWith(`\n\n${extra}`)).toBe(true);
    const context = text.slice(0, -extra.length - 2);
    expect(context).toContain(
      '## Worktree state\n\nM src/ui/level-select.ts\n?? notes/plan.md\n\n2 files changed',
    );
    expect(context).toContain('- replace_file_content: src/ui/result-dialog.ts');
    expect(context.endsWith(CLOSING)).toBe(true);
    expect(context).toContain('## Task\n\nMPG-28: Accessibility pass');
    expect(context).toContain('## Last message from antigravity (argon)');
    expect(context).not.toContain('b'.repeat(4_000));
  });

  it("is the context alone without the person's text, within the limit", () => {
    expect(successorPrompt(base, '')).toBe(buildHandoffPrompt(base));
    const long = successorPrompt(
      {
        ...base,
        gitStatus: 'g'.repeat(40_000),
        recentTools: Array.from({ length: 3_000 }, (_, i) => `Edit: f${i}.ts`),
      },
      '',
    );
    expect(long.length).toBeLessThanOrEqual(20_000);
    expect(long.endsWith(CLOSING)).toBe(true);
  });

  it('refuses text that leaves no room for the context', () => {
    expect(() => successorPrompt(base, 'y'.repeat(19_000))).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'prompt_too_long' }),
    );
  });
});
