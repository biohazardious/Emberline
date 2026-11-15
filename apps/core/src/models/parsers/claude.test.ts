import { readFileSync } from 'node:fs';
import { buildLaunchSpec, CLAUDE_DIALOG_ENV } from '@emberline/adapter-claude';
import { MODEL_ID_RE } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { screenTextOf } from '../screen-text.js';
import { CLAUDE_PICKER, parseClaudePicker } from './claude.js';
import { PickerParseError } from './errors.js';

/**
 * The `.ansi` fixtures are ptyd snapshots (xterm's serialized screen, 160x60) of Claude Code 2.1.325
 * in the sandbox runner, captured by the picker reader itself: not signed in, API billing,
 * `"tui": "fullscreen"`. They are replayed through screen-text exactly as production reads them.
 * The signed-in layout with a "More models" group is only known from the list the owner pasted.
 */
const snapshot = (name: string) =>
  screenTextOf(
    readFileSync(new URL(`../fixtures/claude-2.1.325-${name}.ansi`, import.meta.url), 'utf8'),
    160,
  );
const prompt = snapshot('prompt');
const typedModel = snapshot('typed-model');
const picker = snapshot('picker');
const closed = snapshot('closed');
const typedExit = snapshot('typed-exit');

const pasted = readFileSync(new URL('../fixtures/claude-signed-in-more-models.txt', import.meta.url), 'utf8');
/** The pasted list as the reader sees it before the group opens: the rows above it, then the group. */
const pastedCollapsed = (() => {
  const lines = pasted.trimEnd().split('\n');
  const group = lines.findIndex((l) => l.includes('More models'));
  return lines.slice(0, group + 1).join('\n');
})();

const test = (re: RegExp, text: string) => {
  re.lastIndex = 0;
  return re.test(text);
};
const cursorLines = (screen: string) => screen.split('\n').filter((l) => test(CLAUDE_PICKER.cursorRow, l));

describe('CLAUDE_PICKER', () => {
  it('sees the prompt when it is empty or shows its placeholder, never with typed text', () => {
    expect(prompt).toMatch(/^❯\s+Try "write a test for <filepath>"$/m);
    expect(test(CLAUDE_PICKER.ready, prompt)).toBe(true);
    expect(test(CLAUDE_PICKER.ready, closed)).toBe(true);
    expect(test(CLAUDE_PICKER.ready, typedModel)).toBe(false);
    expect(test(CLAUDE_PICKER.ready, typedExit)).toBe(false);
    // The placeholder screen with `/model` typed over the placeholder.
    const typed = prompt.replace(/^❯(\s+)Try "[^"]*"$/m, '❯$1/model');
    expect(typed).not.toBe(prompt);
    expect(test(CLAUDE_PICKER.ready, typed)).toBe(false);
    expect(test(CLAUDE_PICKER.ready, prompt.replace(/Try "[^"]*"$/m, 'Try "x" and more'))).toBe(false);
  });

  it('presses Enter on /model or /exit only with that command alone at the prompt and highlighted in the menu', () => {
    const typed = CLAUDE_PICKER.typedAtPrompt;
    expect(typed(typedModel, '/model')).toBe(true);
    expect(typed(typedExit, '/exit')).toBe(true);
    // The transcript above shows `❯ /model`; only the prompt line counts.
    expect(typed(typedExit, '/model')).toBe(false);
    expect(typed(typedModel, '/exit')).toBe(false);
    expect(typed(prompt, '/model')).toBe(false);
    expect(typed(picker, '/model')).toBe(false);
    // More than the command at the prompt.
    expect(typed(typedModel.replace(/^(❯[ \u00a0]\/model)$/m, '$1 x'), '/model')).toBe(false);
    // A person's own command that starts the same, highlighted: Enter would run it and send a prompt.
    const own = typedModel
      .replace(/^ {2}❯ \/model( +)/m, '    /model$1')
      .replace(/^(❯[ \u00a0]\/model)$/m, '$1\n  ❯ /model-tweak   Mine');
    expect(own).toContain('❯ /model-tweak');
    expect(own).not.toMatch(/^\s+❯\s+\/model\s{2}/m);
    expect(typed(own, '/model')).toBe(false);
    // No menu at all, or one with nothing highlighted.
    const noMenu = typedModel
      .split('\n')
      .filter((l) => !/^\s+[❯ ]\s*\/\S/.test(l))
      .join('\n');
    expect(noMenu).toMatch(/^❯[ \u00a0]\/model$/m);
    expect(typed(noMenu, '/model')).toBe(false);
  });

  it('tells the open picker from the prompt', () => {
    expect(test(CLAUDE_PICKER.picker, picker)).toBe(true);
    for (const screen of [prompt, typedModel, closed, typedExit])
      expect(test(CLAUDE_PICKER.picker, screen)).toBe(false);
    // The reader counts the prompt only while no picker shows.
    expect(test(CLAUDE_PICKER.ready, picker)).toBe(false);
  });

  it("matches only the picker's cursor row, never Claude's own ❯ prompt or the command menu", () => {
    expect(cursorLines(picker)).toEqual([expect.stringMatching(/^\s+❯ 1\. Default \(recommended\)/)]);
    expect(cursorLines(pasted)).toEqual([expect.stringMatching(/^\s+❯ ▾\s+More models$/)]);
    for (const screen of [prompt, typedModel, closed, typedExit]) expect(cursorLines(screen)).toEqual([]);
  });

  it('finds the cursor on the More models row whatever arrow the collapsed group draws', () => {
    for (const arrow of ['▾', '▴', '▸', '▶', '›']) {
      const collapsed = pastedCollapsed.replace('▾', arrow);
      expect(collapsed).toContain(`❯ ${arrow}   More models`);
      expect(cursorLines(collapsed)).toEqual([`   ❯ ${arrow}   More models`]);
      expect(parseClaudePicker([collapsed]).map((m) => m.id)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    }
    for (const line of ['❯', '❯ ', '❯\u00a0', '❯ /model', '❯\u00a0/model', '  ❯ /model   Set the AI model'])
      expect(test(CLAUDE_PICKER.cursorRow, line)).toBe(false);
    // A group row drawn with no arrow at all is still the group.
    expect(test(CLAUDE_PICKER.cursorRow, '   ❯ More models')).toBe(true);
  });

  it('finds the collapsed More models group by name', () => {
    const groups = pasted.split('\n').filter((l) => test(CLAUDE_PICKER.groupRow, l));
    expect(groups).toHaveLength(1);
    expect(CLAUDE_PICKER.groupRow.exec(groups[0]!)?.[1] ?? CLAUDE_PICKER.groupRow.exec(groups[0]!)?.[0]).toBe(
      'More models',
    );
    // The picker's own hint about other model names is not a group.
    expect(picker.split('\n').filter((l) => test(CLAUDE_PICKER.groupRow, l))).toEqual([]);
  });

  it('starts Claude Code in sandbox mode, with nothing that depends on the folder, and quits with /exit', () => {
    expect(CLAUDE_PICKER.command).toMatchObject({
      file: 'claude',
      args: [],
      env: { CLAUDE_CODE_SANDBOXED: '1' },
    });
    expect(CLAUDE_PICKER.exit).toBe('/exit');
  });

  it('turns off the auto-updater and the dialogs exactly as runs do', () => {
    expect(CLAUDE_PICKER.command.env).toEqual({
      CLAUDE_CODE_SANDBOXED: '1',
      DISABLE_AUTOUPDATER: '1',
      ...CLAUDE_DIALOG_ENV,
    });
    // Every one of these is in a run's env with the same value.
    const run = buildLaunchSpec({
      runId: 'r',
      hookToken: 't',
      coreUrl: 'http://core',
      hookCommand: 'emberline-hook',
      persona: 'coder',
      prompt: 'x',
    } as never).env;
    for (const [key, value] of Object.entries(CLAUDE_PICKER.command.env)) expect(run[key], key).toBe(value);
  });

  it('honours the Claude command override', () => {
    process.env.EMBERLINE_CLAUDE_COMMAND = ' /x/claude ';
    try {
      expect(CLAUDE_PICKER.command.file).toBe('/x/claude');
    } finally {
      delete process.env.EMBERLINE_CLAUDE_COMMAND;
    }
  });
});

describe('parseClaudePicker', () => {
  it('reads the alias rows of the captured picker, labelled from the row, without the Default row', () => {
    expect(parseClaudePicker([picker])).toEqual([
      { id: 'opus', label: 'Opus 5.5', description: 'Best for everyday, complex tasks · $4/$20 per Mtok' },
      {
        id: 'fable',
        label: 'Fable 5.1',
        description: 'Most capable for your hardest and longest-running tasks',
      },
      { id: 'sonnet', label: 'Sonnet 5.5', description: 'Efficient for routine tasks · $2/$10 per Mtok' },
      {
        id: 'haiku',
        label: 'Haiku 5.5',
        description: 'Fastest for quick answers · $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)',
      },
    ]);
  });

  it('reads the signed-in list: versions from the screen, More models as claude-<family>-<version>', () => {
    const models = parseClaudePicker([pastedCollapsed, pasted]);
    expect(models.slice(0, 4)).toEqual([
      { id: 'opus', label: 'Opus 5.5', description: 'For complex work and everyday tasks' },
      { id: 'fable', label: 'Fable 5.2', description: 'For your toughest challenges' },
      { id: 'sonnet', label: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
      { id: 'haiku', label: 'Haiku 5.5', description: 'Fastest for quick answers' },
    ]);
    expect(models.slice(4).map((m) => [m.id, m.label, m.group])).toEqual([
      ['claude-fable-5-1', 'Fable 5.1', 'more'],
      ['claude-haiku-4-5', 'Haiku 4.5', 'more'],
      ['claude-sonnet-5', 'Sonnet 5', 'more'],
      ['claude-opus-5', 'Opus 5', 'more'],
      ['claude-fable-5', 'Fable 5', 'more'],
      ['claude-opus-4-8', 'Opus 4.8', 'more'],
      ['claude-opus-4-7', 'Opus 4.7', 'more'],
      ['claude-opus-4-6', 'Opus 4.6', 'more'],
      ['claude-sonnet-4-6', 'Sonnet 4.6', 'more'],
    ]);
    expect(models[4]!.description).toBe('Most capable for your hardest and longest-running tasks');
    // The expanded screen alone gives the same list.
    expect(parseClaudePicker([pasted])).toEqual(models);
  });

  it('does not depend on the fullscreen chrome around the picker', () => {
    // The captured picker's rows on their own, as an inline (non-fullscreen) Claude would show them.
    const rows = picker
      .split('\n')
      .filter((l) => /^\s+(?:❯\s+)?\d+\./.test(l))
      .join('\n');
    expect(parseClaudePicker([rows])).toEqual(parseClaudePicker([picker]));
  });

  it('turns a row it cannot read into nothing, and every id it gives is valid', () => {
    const odd = [
      '     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
      '     2.  Opus "x" 5             Quoted',
      '     3.  Sonnet 5.5             Most efficient',
      '   ❯ ▾   More models',
      '     4.  Opus "x" 5             Quoted',
      '     5.  Fable $(rm -rf)        Shell',
      '     6.  Opus 4.6               Fine',
    ].join('\n');
    const models = parseClaudePicker([odd]);
    expect(models.map((m) => m.id)).toEqual(['sonnet', 'claude-opus-4-6']);
    for (const m of models) expect(m.id).toMatch(MODEL_ID_RE);
  });

  it('throws PickerParseError for a screen with no model rows', () => {
    expect(() => parseClaudePicker([])).toThrow(PickerParseError);
    expect(() => parseClaudePicker([prompt])).toThrow(PickerParseError);
    expect(() =>
      parseClaudePicker(['   Select model\n\n   Enter to set as default · Esc to cancel']),
    ).toThrow(PickerParseError);
  });
});
