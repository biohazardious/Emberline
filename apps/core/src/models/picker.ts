/**
 * Reads a CLI's `/model` picker from a background terminal, for model discovery. The per-CLI parts
 * (screen patterns, exit command) come in a {@link PickerScript}; parsing the screens is the CLI
 * parsers' job.
 *
 * Safe by construction: in Claude Code, Enter on a model row saves that model as the default for new
 * sessions, so the only keys this ever types are `/model` and Enter at the CLI's prompt, Down, Enter
 * on a collapsed group row, Esc, and the exit command at the prompt. Enter in the picker is pressed
 * only when a fresh, settled snapshot shows the cursor on a group row; Enter at the prompt only when
 * a fresh, settled snapshot shows exactly the command typed there, with the CLI's command menu (which
 * runs its highlighted entry on Enter) on that same command. Every key waits for its own effect (not
 * just any change: a status line or a notice can redraw at any time) before the next one is sent, so
 * no key is still in flight when Enter goes.
 */
import type { PtydClient } from '@emberline/ptyd/client';
import { screenTextOf } from './screen-text.js';

export interface PickerScript {
  command: { file: string; args: string[]; env: Record<string, string> };
  /** The CLI's prompt, waiting for input. */
  ready: RegExp;
  /** The open picker. */
  picker: RegExp;
  /** A collapsed group of models (e.g. "More models"); its first capture group, if any, names it. */
  groupRow: RegExp;
  /** The row the picker's cursor is on. */
  cursorRow: RegExp;
  /**
   * The screen shows `text`, and nothing else, typed at the prompt, and Enter would run exactly that
   * command (see {@link commandTyped}).
   */
  typedAtPrompt: (screen: string, text: string) => boolean;
  /** Typed at the prompt, then Enter, to quit the CLI. */
  exit: string;
  /** How long each step waits for the screen it expects. */
  stepTimeoutMs: number;
}

/** The step whose expected screen did not appear. */
export type PickerStep = 'ready' | 'type' | 'picker' | 'group' | 'expand' | 'group_closed' | 'close';

const STEP_FAILURES: Record<PickerStep, string> = {
  ready: 'its prompt did not appear',
  type: 'typing /model at its prompt did not show /model alone, with its command menu on /model',
  picker: 'the /model picker did not open',
  group: 'the picker cursor could not be moved onto a collapsed group',
  expand: 'a collapsed group in the picker did not open',
  group_closed:
    "the picker closed when Enter was pressed on a group row, as if a model had been picked; check that the CLI's default model is still the one you chose",
  close: 'the picker did not close',
};

export class PickerError extends Error {
  constructor(
    readonly step: PickerStep,
    /** The end of the last screen seen, for the failure's diagnosis. */
    readonly screenTail: string,
  ) {
    super(STEP_FAILURES[step]);
    this.name = 'PickerError';
  }
}

type PickerPtyd = Pick<PtydClient, 'spawn' | 'write' | 'snapshot' | 'kill' | 'remove' | 'list'>;

const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
/** Wide and tall enough that a picker with its groups open fits the screen. */
const COLS = 160;
const ROWS = 60;
const MAX_DOWN_PRESSES = 40;
const MAX_ESC_PRESSES = 3;
/** Bounds a picker that keeps showing new groups. */
const MAX_GROUPS = 10;
/** How long the CLI gets to quit by itself after its exit command before it is killed. */
const EXIT_WAIT_MS = 3_000;
const POLL_MS = 50;
/** A screen counts as drawn once it has not changed for this long. */
const SETTLE_MS = 150;
const TAIL_LINES = 20;
const TAIL_CHARS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `test` without the state a `g` or `y` flag keeps between calls. */
function matches(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  const hit = re.test(text);
  re.lastIndex = 0;
  return hit;
}

function tail(screen: string): string {
  return screen.split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
}

/**
 * A {@link PickerScript.typedAtPrompt} for a CLI whose prompt line starts with `promptMark` and whose
 * command menu marks its highlighted entry with `❯` (Claude Code's layout): the last prompt line
 * holds exactly `text`, and a menu, if one shows, has exactly one highlighted entry, `text` itself.
 * A person's own command that starts the same (`/model-x`) and is highlighted would be run by Enter.
 */
export function commandTyped(promptMark: string): (screen: string, text: string) => boolean {
  return (screen, text) => {
    const lines = screen.replace(/\u00a0/g, ' ').split('\n');
    const prompt = lines.findLast((l) => l.startsWith(promptMark));
    if (prompt === undefined || prompt.slice(promptMark.length).trim() !== text) return false;
    const highlighted = lines
      .filter((l) => /^\s+❯\s+\//.test(l))
      .map(
        (l) =>
          l
            .trim()
            .slice(1)
            .trim()
            .split(/\s{2,}/)[0],
      );
    return highlighted.length === 1 && highlighted[0] === text;
  };
}

/** A group row's name: the pattern's first capture group, else the whole match. */
function groupKey(re: RegExp, line: string): string | undefined {
  re.lastIndex = 0;
  const m = re.exec(line);
  re.lastIndex = 0;
  return m ? (m[1] ?? m[0]) : undefined;
}

export async function readPicker(
  client: PickerPtyd,
  script: PickerScript,
  opts: { cwd: string; deadlineMs: number },
): Promise<{ screens: string[] }> {
  const deadline = Date.now() + opts.deadlineMs;
  const { file, args, env } = script.command;
  const { id } = await client.spawn({
    file,
    args,
    cwd: opts.cwd,
    env,
    cols: COLS,
    rows: ROWS,
    // The picker can show account details; ptyd keeps no log of it.
    meta: { title: `Model discovery · ${file}`, noLog: '1' },
  });

  /** The visible screen as plain text (no scrollback, so an earlier screen cannot match). */
  const screenText = async (): Promise<string> => {
    const snap = await client.snapshot(id, 0);
    return screenTextOf(snap.data ?? '', snap.cols);
  };

  /**
   * Polls until a settled screen passes `accept`; throws a {@link PickerError} for `step` when the
   * step's time or the job's deadline runs out first.
   */
  const waitFor = async (step: PickerStep, accept: (screen: string) => boolean): Promise<string> => {
    const end = Math.min(Date.now() + script.stepTimeoutMs, deadline);
    let last = await screenText();
    let changedAt = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - changedAt >= SETTLE_MS && accept(last)) return last;
      if (now >= end) throw new PickerError(step, tail(last));
      await sleep(Math.min(POLL_MS, Math.max(0, end - now)));
      const next = await screenText();
      if (next !== last) {
        last = next;
        changedAt = Date.now();
      }
    }
  };

  const atPrompt = (screen: string) => matches(script.ready, screen) && !matches(script.picker, screen);

  /** The line the picker's cursor is on; none unless the picker shows and exactly one line matches. */
  const cursorAt = (screen: string): number | undefined => {
    if (!matches(script.picker, screen)) return undefined;
    const at = screen.split('\n').flatMap((l, i) => (matches(script.cursorRow, l) ? [i] : []));
    return at.length === 1 ? at[0] : undefined;
  };

  /** The cursor is on the group row named `key`. */
  const cursorOnGroup = (screen: string, key: string): boolean => {
    const at = cursorAt(screen);
    return at !== undefined && groupKey(script.groupRow, screen.split('\n')[at]!) === key;
  };

  /**
   * Types `text` at the prompt and waits for it to show alone, with the CLI's menu on it; false
   * (nothing more typed) when that never shows. The last word goes to a snapshot taken right now.
   */
  const typeCommand = async (step: PickerStep, text: string): Promise<boolean> => {
    await client.write(id, text);
    const shown = await waitFor(step, (s) => script.typedAtPrompt(s, text)).catch(() => undefined);
    return shown !== undefined && script.typedAtPrompt(await screenText(), text);
  };

  /** Whether the CLI quit by itself within `ms`. */
  const exitedWithin = async (ms: number): Promise<boolean> => {
    const end = Math.min(Date.now() + ms, deadline);
    for (;;) {
      const session = (await client.list()).sessions.find((s) => s.id === id);
      if (!session || session.status === 'exited') return true;
      if (Date.now() >= end) return false;
      await sleep(POLL_MS);
    }
  };

  /** The first group row on the screen not opened yet. */
  const nextGroup = (screen: string, opened: Set<string>): string | undefined => {
    for (const line of screen.split('\n')) {
      const key = groupKey(script.groupRow, line);
      if (key !== undefined && !opened.has(key)) return key;
    }
    return undefined;
  };

  let exited = false;
  try {
    const screens: string[] = [];
    let screen = await waitFor('ready', atPrompt);

    // Enter runs whatever the command menu has highlighted: a person's own `/model-…` command would
    // send a prompt. Anything but `/model` itself is backed out of with Esc, and the read fails.
    if (!(await typeCommand('type', '/model'))) {
      await client.write(id, ESC).catch(() => undefined);
      throw new PickerError('type', tail(await screenText()));
    }
    await client.write(id, ENTER);
    screen = await waitFor('picker', (s) => matches(script.picker, s));
    screens.push(screen);

    const opened = new Set<string>();
    for (let key = nextGroup(screen, opened); key !== undefined; key = nextGroup(screen, opened)) {
      if (opened.size >= MAX_GROUPS) break;
      for (let presses = 0; !cursorOnGroup(screen, key); presses++) {
        const from = cursorAt(screen);
        // Without exactly one cursor row a Down's effect cannot be told apart from any other redraw.
        if (presses >= MAX_DOWN_PRESSES || from === undefined) throw new PickerError('group', tail(screen));
        await client.write(id, DOWN);
        // Only the cursor moving acknowledges the Down; one that does not move it ends the step here.
        screen = await waitFor('group', (s) => {
          const at = cursorAt(s);
          return at !== undefined && at !== from;
        });
      }
      // The last word before Enter goes to a snapshot taken right now, not the one that decided.
      const at = cursorAt(screen);
      const fresh = await screenText();
      if (cursorAt(fresh) !== at || !cursorOnGroup(fresh, key)) throw new PickerError('group', tail(fresh));
      opened.add(key);
      await client.write(id, ENTER);
      // The group opened: the picker closed, its cursor or the group row changed, or rows were added.
      const lines = fresh.split('\n');
      screen = await waitFor('expand', (s) => {
        const now = s.split('\n');
        return cursorAt(s) !== at || now[at!] !== lines[at!] || now.length > lines.length;
      });
      // A group that opens keeps the picker up; a picker that closes looks just like a model picked.
      if (!matches(script.picker, screen)) throw new PickerError('group_closed', tail(screen));
      screens.push(screen);
    }

    // Esc again only while the picker still shows: at the prompt a second Esc can open other menus.
    for (let presses = 0; !atPrompt(screen); presses++) {
      if (presses >= MAX_ESC_PRESSES) throw new PickerError('close', tail(screen));
      await client.write(id, ESC);
      try {
        screen = await waitFor('close', atPrompt);
      } catch (error) {
        if (!(error instanceof PickerError) || Date.now() >= deadline) throw error;
        screen = await screenText();
      }
    }

    // Enter only once the exit command alone shows at the prompt, so nothing else can be submitted;
    // otherwise the CLI is killed below. A CLI that quits by itself is not killed: Claude Code writes
    // its state file on the way out, and every run shares that file.
    if (await typeCommand('close', script.exit)) {
      await client.write(id, ENTER);
      exited = await exitedWithin(EXIT_WAIT_MS).catch(() => false);
    }
    return { screens };
  } finally {
    if (!exited) await client.kill(id).catch(() => {});
    await client.remove(id).catch(() => {});
  }
}
