#!/usr/bin/env node
/**
 * A stand-in for a CLI with a `/model` picker, shaped after Claude Code's, for the picker reader's
 * tests. It records what a real CLI would treat as a change or a prompt in `FAKE_PICKER_LOG`:
 * `SAVED <id>` when Enter is pressed on a model row (Claude Code saves that model as the default for
 * new sessions) and `PROMPT <text>` when anything but a known command is submitted at the prompt.
 *
 * `FAKE_PICKER_MODE`, comma-separated: `update` shows an update screen instead of the prompt; `stuck`
 * ignores Down in the picker; `skip` moves the cursor round the model rows only, never onto the group
 * row; `gaps` lays the picker out with cursor moves instead of spaces (as many TUIs do); `noisy`
 * redraws a status line at once on every key and applies the key itself only after a delay longer
 * than the reader's settle time.
 */
import { appendFileSync } from 'node:fs';

const modes = new Set((process.env.FAKE_PICKER_MODE ?? '').split(','));
const KEY_DELAY_MS = 400;
const logFile = process.env.FAKE_PICKER_LOG;

const log = (line) => {
  if (logFile) appendFileSync(logFile, `${line}\n`);
};

const MODELS = [
  { id: 'default', label: 'Default (recommended)', note: 'Use the default model (currently Opus 5.5)' },
  { id: 'opus', label: 'Opus', note: 'Opus 5.5 · Most capable for complex work', current: true },
  { id: 'sonnet', label: 'Sonnet', note: 'Sonnet 5 · Best for everyday tasks' },
  { id: 'haiku', label: 'Haiku', note: 'Haiku 4.5 · Fastest for quick answers' },
];
const MORE = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'Fable 5.1 · Long-form writing' },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', note: 'Opus 4.1 · Legacy' },
];

let screen = modes.has('update') ? 'update' : 'prompt';
let tick = 0;
let input = '';
let expanded = false;
let cursor = MODELS.findIndex((m) => m.current);

/** The picker's selectable rows, top to bottom: the models, the group row, then the group's models. */
function rows() {
  const out = MODELS.map((m) => ({ kind: 'model', ...m }));
  out.push({ kind: 'group' });
  if (expanded) out.push(...MORE.map((m) => ({ kind: 'model', ...m })));
  return out;
}

function pickerLines() {
  const lines = [' Select model', ' Switch between models. Applies to this session and future sessions.', ''];
  let n = 0;
  rows().forEach((row, i) => {
    const mark = i === cursor ? '❯' : ' ';
    // `gaps`: skip blank cells with a cursor move (CSI n C), so the cells stay unwritten.
    const gap = (n) => (modes.has('gaps') ? `\x1b[${n}C` : ' '.repeat(n));
    if (row.kind === 'group') {
      lines.push(`${gap(1)}${mark}${gap(1)}${expanded ? '▴' : '▾'} More models`);
      return;
    }
    n += 1;
    const label = `${n}. ${row.label}${row.current ? ' ✔' : ''}`;
    lines.push(`${gap(1)}${mark}${gap(1)}${label}${gap(28 - label.length)}${row.note}`);
  });
  lines.push('', ' Enter to confirm · Esc to exit');
  return lines;
}

function render() {
  let lines;
  if (screen === 'update') {
    lines = [' Fake Picker CLI 9.9.9 is available (you have 1.0.0).', '', ' Press Enter to update now.'];
  } else if (screen === 'picker') {
    lines = pickerLines();
  } else {
    lines = [' Fake Picker CLI 1.0.0', '', `> ${input}`];
  }
  if (modes.has('noisy')) lines.push('', ` status: ${tick}`);
  process.stdout.write(`\x1b[H\x1b[2J${lines.join('\r\n')}`);
}

function submit() {
  const text = input.trim();
  input = '';
  if (text === '/exit') process.exit(0);
  if (text === '/model') {
    screen = 'picker';
    cursor = MODELS.findIndex((m) => m.current);
  } else if (text) {
    log(`PROMPT ${text}`);
  }
}

function down() {
  if (modes.has('stuck')) return;
  const count = rows().length;
  if (modes.has('skip')) {
    cursor = (cursor + 1) % MODELS.length;
    return;
  }
  if (cursor < count - 1) cursor += 1;
}

function key(name, char) {
  if (name === 'ctrl-c') process.exit(130);
  if (!modes.has('noisy')) return apply(name, char);
  // Something unrelated changes on screen right away; the key's own effect shows up later.
  tick += 1;
  render();
  setTimeout(() => apply(name, char), KEY_DELAY_MS);
}

function apply(name, char) {
  if (screen === 'update') return;
  if (screen === 'prompt') {
    if (name === 'enter') submit();
    else if (name === 'backspace') input = input.slice(0, -1);
    else if (name === 'char') input += char;
  } else if (screen === 'picker') {
    if (name === 'escape') screen = 'prompt';
    else if (name === 'down') down();
    else if (name === 'up') cursor = Math.max(0, cursor - 1);
    else if (name === 'enter') {
      const row = rows()[cursor];
      if (row.kind === 'group') {
        expanded = !expanded;
      } else {
        log(`SAVED ${row.id}`);
        screen = 'prompt';
      }
    }
  }
  render();
}

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const KEYS = [
  ['\x1b[B', 'down'],
  ['\x1b[A', 'up'],
  ['\x1b', 'escape'],
  ['\r', 'enter'],
  ['\x7f', 'backspace'],
  ['\x03', 'ctrl-c'],
];

process.stdin.on('data', (data) => {
  let rest = data;
  while (rest) {
    const known = KEYS.find(([seq]) => rest.startsWith(seq));
    if (known) key(known[1]);
    else key('char', rest[0]);
    rest = rest.slice(known ? known[0].length : 1);
  }
});
render();
