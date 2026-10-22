import { HOLD_LABELS } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import type { MergeProbeResult } from '../factory/merge-probe.js';
import { buildRecovery, type RecoveryInput } from './recovery.js';

const REMINDER = '\n\nWhen finished, call `ticket_complete` again.';
const WT = '/workspaces/landing/.worktrees/el-6';

const input = (
  type: string,
  payload: Record<string, unknown> | null = {},
  more: Partial<RecoveryInput> = {},
): RecoveryInput => ({
  hold: { type, payload },
  ticketKey: 'EL-6',
  mainBranch: 'main',
  worktreePath: WT,
  probe: null,
  superseding: null,
  movedBy: [],
  reviewComments: [],
  completionReminder: REMINDER,
  ...more,
});

const probe = (...conflicts: [string, string][]): MergeProbeResult => ({
  ok: true,
  mainHead: 'aaa',
  branchHead: 'bbb',
  conflicts: conflicts.map(([path, kind]) => ({ path, kind })),
});

/** Every recovery: its HOLD_LABELS label, at most three suggestions, every prompt ending with the reminder, no hold code shown. */
function expectWellFormed(type: string, r: ReturnType<typeof buildRecovery>): void {
  expect(r.hold).toBe(type);
  expect(r.label).toBe(HOLD_LABELS[type]);
  expect(r.suggestions.length).toBeGreaterThan(0);
  expect(r.suggestions.length).toBeLessThanOrEqual(3);
  for (const s of r.suggestions) {
    if (s.kind === 'prompt') {
      expect(s.prompt).toBeTruthy();
      expect(s.prompt!.endsWith(REMINDER)).toBe(true);
    } else {
      expect(s.prompt).toBeNull();
    }
    for (const text of [r.why, s.label, s.detail ?? '']) expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
  }
}

describe('buildRecovery: merge_failed', () => {
  it('conflicts now: Resolve conflicts with the current list, Discard, Resolve by hand', () => {
    const r = buildRecovery(
      input(
        'merge_failed',
        { conflicts: ['old.txt'] },
        {
          probe: probe(['.gitignore', 'content'], ['PROJECT.md', 'content'], ['astro.config.ts', 'add/add']),
        },
      ),
    );
    expectWellFormed('merge_failed', r);
    expect(r.why).toBe('main moved on and 3 files now conflict: .gitignore, PROJECT.md, astro.config.ts');
    expect(r.suggestions.map((s) => s.kind)).toEqual(['prompt', 'discard', 'manual']);
    const [resolve, , manual] = r.suggestions;
    expect(resolve!.id).toBe('resolve_conflicts');
    expect(resolve!.prompt).toContain('conflicts in: .gitignore, PROJECT.md, astro.config.ts');
    expect(resolve!.prompt).not.toContain('old.txt');
    expect(resolve!.files).toEqual(['.gitignore', 'PROJECT.md', 'astro.config.ts']);
    expect(manual!.files).toEqual(['.gitignore', 'PROJECT.md', 'astro.config.ts']);
    expect(manual!.commands[0]).toBe(`git -C ${WT} merge main`);
    expect(manual!.commands.length).toBeGreaterThan(1);
  });

  it('shortens a long conflict list in the why line', () => {
    const files = Array.from({ length: 11 }, (_, i): [string, string] => [`f${i}.ts`, 'add/add']);
    const r = buildRecovery(input('merge_failed', {}, { probe: probe(...files) }));
    expect(r.why).toBe('main moved on and 11 files now conflict: f0.ts, f1.ts, f2.ts and 8 more');
  });

  it('names the tickets that moved main', () => {
    const one = buildRecovery(
      input('merge_failed', {}, { probe: probe(['app.js', 'content']), movedBy: ['EL-12'] }),
    );
    expect(one.why).toBe('main moved on (EL-12) and 1 file now conflicts: app.js');
    const two = buildRecovery(
      input('merge_failed', {}, { probe: probe(['app.js', 'content']), movedBy: ['EL-12', 'EL-14'] }),
    );
    expect(two.why).toBe('main moved on (EL-12, EL-14) and 1 file now conflicts: app.js');
    const many = buildRecovery(
      input(
        'merge_failed',
        {},
        { probe: probe(['app.js', 'content']), movedBy: ['EL-12', 'EL-14', 'EL-15', 'EL-16'] },
      ),
    );
    expect(many.why).toBe('main moved on (EL-12, EL-14 and 2 more) and 1 file now conflicts: app.js');
  });

  it('no conflicts now: Merge now, Discard', () => {
    const r = buildRecovery(input('merge_failed', { conflicts: ['a'] }, { probe: probe() }));
    expectWellFormed('merge_failed', r);
    expect(r.suggestions.map((s) => [s.kind, s.id])).toEqual([
      ['merge', 'merge_now'],
      ['discard', 'discard'],
    ]);
    expect(r.why).toContain('merges cleanly');
  });

  it('a merge that failed without conflicts names git’s reason, not "merges cleanly"', () => {
    const summary =
      'git -c core.fsmonitor=false -c core.hooksPath=/dev/null exited with code 128: fatal: .git/index: index file open failed: Permission denied';
    const r = buildRecovery(input('merge_failed', { summary }, { probe: probe() }));
    expectWellFormed('merge_failed', r);
    expect(r.why).toBe('the merge into main failed: .git/index: index file open failed: Permission denied');
    expect(r.suggestions.map((s) => [s.kind, s.id, s.label])).toEqual([
      ['merge', 'merge_now', 'Try the merge again'],
      ['discard', 'discard', 'Discard this work'],
    ]);
    expect(r.suggestions[0]!.detail).toContain('uid 1000');
  });

  it('a refused merge reports the reason inside the merge summary', () => {
    const summary =
      'Could not merge EL-6 into the main workspace (error: The following untracked working tree files would be overwritten by merge:); it was left unchanged.';
    const r = buildRecovery(input('merge_failed', { summary }, { probe: probe() }));
    expect(r.why).toBe(
      'the merge into main failed: The following untracked working tree files would be overwritten by merge:',
    );
    expect(r.suggestions[0]).toMatchObject({ id: 'merge_now', label: 'Try the merge again' });
    expect(r.suggestions[0]!.detail).not.toContain('uid 1000');
  });

  it('a merge that failed without conflicts keeps its reason when the comparison fails too', () => {
    const r = buildRecovery(
      input(
        'merge_failed',
        { summary: 'fatal: .git/index.lock: File exists.' },
        { probe: { ok: false, error: 'fatal: bad revision' } },
      ),
    );
    expect(r.why).toBe('the merge into main failed: .git/index.lock: File exists.');
    expect(r.suggestions.map((s) => s.id)).toEqual(['merge_now', 'discard']);
  });

  it('main moved on since a merge that failed without conflicts: the conflicts win', () => {
    const r = buildRecovery(
      input('merge_failed', { summary: 'fatal: Permission denied' }, { probe: probe(['a.ts', 'content']) }),
    );
    expect(r.why).toBe('main moved on and 1 file now conflicts: a.ts');
  });

  it('superseded by a done ticket at half or more: Discard first, naming it', () => {
    const files = Array.from({ length: 11 }, (_, i): [string, string] => [`f${i}.ts`, 'add/add']);
    const r = buildRecovery(
      input(
        'merge_failed',
        {},
        { probe: probe(...files), superseding: { key: 'EL-10', files: 11, of: 11, done: true } },
      ),
    );
    expectWellFormed('merge_failed', r);
    expect(r.suggestions[0]).toMatchObject({
      kind: 'discard',
      detail: 'EL-10 already added these files (11 of 11 conflicts).',
    });
    expect(r.suggestions.map((s) => s.kind)).toEqual(['discard', 'prompt', 'manual']);
  });

  it('exactly half is enough; less is not', () => {
    const files: [string, string][] = [
      ['a', 'add/add'],
      ['b', 'add/add'],
      ['c', 'content'],
      ['d', 'content'],
    ];
    const half = buildRecovery(
      input(
        'merge_failed',
        {},
        { probe: probe(...files), superseding: { key: 'EL-10', files: 2, of: 4, done: true } },
      ),
    );
    expect(half.suggestions[0]!.kind).toBe('discard');
    const less = buildRecovery(
      input(
        'merge_failed',
        {},
        { probe: probe(...files), superseding: { key: 'EL-10', files: 1, of: 4, done: true } },
      ),
    );
    expect(less.suggestions[0]!.kind).toBe('prompt');
  });

  it('superseded by a ticket that is not done: Discard is not first', () => {
    const files = Array.from({ length: 4 }, (_, i): [string, string] => [`f${i}.ts`, 'add/add']);
    const r = buildRecovery(
      input(
        'merge_failed',
        {},
        { probe: probe(...files), superseding: { key: 'EL-10', files: 4, of: 4, done: false } },
      ),
    );
    expect(r.suggestions[0]!.kind).toBe('prompt');
    expect(r.suggestions.map((s) => s.kind)).toEqual(['prompt', 'discard', 'manual']);
  });

  it('probe error: why "could not compare with main: …", generic suggestions from the stored conflicts', () => {
    const r = buildRecovery(
      input(
        'merge_failed',
        { conflicts: ['app.js'] },
        {
          probe: {
            ok: false,
            error: 'git -c core.hooksPath=/dev/null exited with code 128: fatal: Needed a single revision',
          },
        },
      ),
    );
    expectWellFormed('merge_failed', r);
    expect(r.why).toBe('could not compare with main: Needed a single revision');
    expect(r.suggestions.map((s) => s.kind)).toEqual(['prompt', 'discard', 'manual']);
    expect(r.suggestions[0]!.prompt).toContain('app.js');
  });

  it('probe error on an old payload without conflicts: a generic resolve prompt', () => {
    const r = buildRecovery(input('merge_failed', null, { probe: { ok: false, error: 'boom' } }));
    expectWellFormed('merge_failed', r);
    expect(r.suggestions[0]!.prompt).toMatch(/^Merge main into your branch/);
  });

  it('quotes a worktree path with spaces in the manual commands', () => {
    const r = buildRecovery(
      input('merge_failed', {}, { worktreePath: '/w/my project', probe: probe(['a', 'content']) }),
    );
    expect(r.suggestions.find((s) => s.kind === 'manual')!.commands[0]).toBe(
      "git -C '/w/my project' merge main",
    );
  });
});

describe('buildRecovery: the other holds', () => {
  it('build_gate_failed: Fix the checks with the stored output, Run Build & Verify', () => {
    const r = buildRecovery(
      input('build_gate_failed', { output: 'src/a.ts(3,1): error TS2304\nFound 1 error.\n' }),
    );
    expectWellFormed('build_gate_failed', r);
    expect(r.why).toBe('the checks failed: Found 1 error.');
    expect(r.suggestions.map((s) => [s.kind, s.id])).toEqual([
      ['prompt', 'fix_checks'],
      ['manual', 'run_checks'],
    ]);
    expect(r.suggestions[0]!.prompt).toContain('error TS2304');
  });

  it('build_gate_failed from before the output was kept: generic text', () => {
    const r = buildRecovery(input('build_gate_failed', { autoFix: false }));
    expectWellFormed('build_gate_failed', r);
    expect(r.why).toBe('the checks failed');
    expect(r.suggestions[0]!.prompt).toMatch(/^Run the project's checks and fix every failure/);
  });

  it('build_gate_error: the checks could not run + the message', () => {
    const r = buildRecovery(input('build_gate_error', { message: 'spawn npm ENOENT' }));
    expectWellFormed('build_gate_error', r);
    expect(r.why).toBe('the checks could not run: spawn npm ENOENT');
    expect(r.suggestions.map((s) => s.kind)).toEqual(['prompt', 'manual']);
    expect(r.suggestions[0]!.prompt).toContain('spawn npm ENOENT');
  });

  it('critic_blocked: the code audit, its stored follow-up prompt, Open review', () => {
    const r = buildRecovery(
      input('critic_blocked', {
        followUpPrompt: 'Deterministic code audit: handle the null case in parse().',
      }),
    );
    expectWellFormed('critic_blocked', r);
    expect(r.why).toBe('the code audit asked for changes');
    expect(r.suggestions.map((s) => [s.kind, s.id])).toEqual([
      ['prompt', 'apply_audit'],
      ['open_review', 'open_review'],
    ]);
    expect(r.suggestions[0]!.prompt).toMatch(/^Deterministic code audit: handle the null case/);
  });

  it('critic_blocked without a stored prompt: generic text', () => {
    const r = buildRecovery(input('critic_blocked', {}));
    expect(r.suggestions[0]!.prompt).toMatch(/^Address the code audit's findings/);
  });

  it('secret_guard_blocked: N possible secrets, Remove the secrets, Open review', () => {
    const r = buildRecovery(input('secret_guard_blocked', { secretLeakCount: 2 }));
    expectWellFormed('secret_guard_blocked', r);
    expect(r.why).toBe('2 possible secrets in the diff');
    expect(r.suggestions.map((s) => s.kind)).toEqual(['prompt', 'open_review']);
    const text = r.suggestions[0]!.prompt!;
    expect(text).toContain('history');
    expect(text).toContain('environment variables');
    expect(text).toContain('.env');
    expect(buildRecovery(input('secret_guard_blocked', { secretLeakCount: 1 })).why).toBe(
      '1 possible secret in the diff',
    );
    expect(buildRecovery(input('secret_guard_blocked', null)).why).toBe('possible secrets in the diff');
  });

  it("secret_guard_blocked keeps the guard's findings in the prompt when stored", () => {
    const r = buildRecovery(
      input('secret_guard_blocked', {
        secretLeakCount: 1,
        autoFixPrompt: 'config.ts:3 looks like an API key',
      }),
    );
    expect(r.suggestions[0]!.prompt).toContain('config.ts:3 looks like an API key');
  });

  it('slop_guard_blocked: Fix them with the stored prompt, Open review', () => {
    const r = buildRecovery(input('slop_guard_blocked', { autoFixPrompt: 'Remove the TODO in a.ts:4.' }));
    expectWellFormed('slop_guard_blocked', r);
    expect(r.why).toBe('the quality guard found problems');
    expect(r.suggestions.map((s) => s.kind)).toEqual(['prompt', 'open_review']);
    expect(r.suggestions[0]!.prompt).toMatch(/^Remove the TODO in a\.ts:4\./);
    expect(buildRecovery(input('slop_guard_blocked', {})).suggestions[0]!.prompt).toMatch(
      /^Fix the problems the quality guard found/,
    );
  });

  it('completion_missing: Ask for completion', () => {
    const r = buildRecovery(input('completion_missing', {}));
    expectWellFormed('completion_missing', r);
    expect(r.why).toBe('the agent stopped without reporting completion');
    expect(r.suggestions.map((s) => [s.kind, s.id])).toEqual([['prompt', 'ask_completion']]);
    expect(r.suggestions[0]!.prompt).toContain('ticket_complete');
  });

  it('completion_blocked: the blockers quoted for the person to answer, Discard', () => {
    const r = buildRecovery(input('completion_blocked', { blockers: ['Which API key?', 'No staging URL'] }));
    expectWellFormed('completion_blocked', r);
    expect(r.why).toBe('the agent reported blockers: Which API key?; No staging URL');
    expect(r.suggestions.map((s) => s.kind)).toEqual(['prompt', 'discard']);
    expect(r.suggestions[0]!.prompt).toContain('> Which API key?\n> No staging URL');
  });

  it('review_blocked: Open review first, then Address the comments listing them', () => {
    const r = buildRecovery(
      input(
        'review_blocked',
        { count: 2 },
        { reviewComments: ['src/a.ts:3: use the helper', 'README.md: typo'] },
      ),
    );
    expectWellFormed('review_blocked', r);
    expect(r.why).toBe('2 blocking review comments are open');
    expect(r.suggestions.map((s) => [s.kind, s.id])).toEqual([
      ['open_review', 'open_review'],
      ['prompt', 'address_comments'],
    ]);
    expect(r.suggestions[1]!.prompt).toContain('- src/a.ts:3: use the helper\n- README.md: typo');
    expect(buildRecovery(input('review_blocked', { count: 1 })).why).toBe(
      '1 blocking review comment is open',
    );
  });

  it('no_changes: Do the ticket, Mark done anyway (merge), Discard', () => {
    const r = buildRecovery(input('no_changes', { autoFix: false }));
    expectWellFormed('no_changes', r);
    expect(r.label).toBe('Finished without changes');
    expect(r.why).toBe('the agent ended without changing anything or saying what it did');
    expect(r.suggestions.map((s) => [s.kind, s.id, s.label])).toEqual([
      ['prompt', 'do_the_ticket', 'Do the ticket'],
      ['merge', 'merge_now', 'Mark done anyway'],
      ['discard', 'discard', 'Close as not needed'],
    ]);
    const [, merge, discard] = r.suggestions;
    expect(merge!.detail).toBe('Move EL-6 to Done as finished. There is nothing to merge.');
    expect(discard!.detail).toBe(
      'Move EL-6 to Done as not needed. Nothing is merged, and the branch is kept until the next cleanup.',
    );
    expect(r.suggestions[0]!.prompt).toMatch(/^The ticket asks for changes, but you made none\./);
    expect(r.suggestions[0]!.prompt).toContain('explain why nothing is needed');
  });

  it('no_changes for an agent without the completion tool: no "saying what it did", the reply is the explanation', () => {
    const r = buildRecovery(input('no_changes', { autoFix: false }, { completionReminder: '' }));
    expect(r.why).toBe('the agent ended without changing anything');
    expect(r.suggestions.map((s) => s.id)).toEqual(['do_the_ticket', 'merge_now', 'discard']);
    const prompt = r.suggestions[0]!.prompt!;
    expect(prompt).toMatch(/^The ticket asks for changes, but you made none\. Do the work it asks for/);
    expect(prompt).toContain('explain why in your reply');
    expect(prompt).toContain('a person will mark the ticket done');
    expect(prompt).not.toContain('explain why nothing is needed and finish');
  });

  it('a prompt without the completion tool ends with the prompt itself', () => {
    const r = buildRecovery(input('completion_missing', {}, { completionReminder: '' }));
    expect(r.suggestions[0]!.prompt!.endsWith('say what blocks you.')).toBe(true);
  });
});

describe('buildRecovery: the worktree config holds', () => {
  const yml = {
    check: 'worktree_yml',
    autoFix: false,
    output: '.emberline/worktree.yml is not valid:\nchecks: Unrecognized key: "container"',
  };

  it('build_gate_failed from the worktree config check: its own label and suggestions, no Build & Verify', () => {
    const r = buildRecovery(input('build_gate_failed', yml));
    expect(r.label).toBe('Worktree config is not valid');
    expect(r.why).toBe(
      'the run\'s .emberline/worktree.yml is not valid: checks: Unrecognized key: "container"',
    );
    expect(r.suggestions.map((s) => s.id)).toEqual(['fix_worktree_yml', 'open_review', 'discard']);
    expect(r.suggestions[0]!.prompt).toContain('checks: Unrecognized key: "container"');
    expect(r.suggestions[0]!.prompt!.endsWith(REMINDER)).toBe(true);
  });

  it('an older note without `check` is recognised by its output', () => {
    const { check: _check, ...old } = yml;
    const r = buildRecovery(input('build_gate_failed', old));
    expect(r.label).toBe('Worktree config is not valid');
    expect(r.suggestions.map((s) => s.id)).toEqual(['fix_worktree_yml', 'open_review', 'discard']);
  });

  it('missing worktree commands: their own label and why', () => {
    const r = buildRecovery(
      input('build_gate_failed', { check: 'worktree_commands', autoFix: false, output: 'no commands' }),
    );
    expect(r.label).toBe('Worktree commands are missing');
    expect(r.why).toBe(
      'the bootstrap left .emberline/worktree.yml without setup, build, lint or test commands',
    );
    expect(r.suggestions.map((s) => s.id)).toEqual(['fix_worktree_yml', 'open_review', 'discard']);
  });

  it('an ordinary failed build still offers Build & Verify', () => {
    const r = buildRecovery(input('build_gate_failed', { output: 'boom' }));
    expect(r.label).toBe('Build checks failed');
    expect(r.suggestions.map((s) => s.id)).toEqual(['fix_checks', 'run_checks']);
  });
});
