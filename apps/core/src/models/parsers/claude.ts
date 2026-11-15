/**
 * Claude Code's `/model` picker: the script the picker reader follows, and the parser for the
 * screens it returns. Written against Claude Code 2.1.325 (snapshots captured by the reader itself,
 * signed out, fullscreen TUI) and the signed-in list with its "More models" group as shown by
 * 2.1.32x; see the fixtures.
 *
 * The picker has two kinds of rows. Rows above "More models" are the aliases Claude Code takes for
 * `--model` (`opus`, `fable`, …): signed out a row reads "Opus" with "Opus 5.5 · …" as its
 * description, signed in it reads "Opus 5.5". Rows inside "More models" are older or other versions,
 * which `--model` takes by full name (`Fable 5.1` → `claude-fable-5-1`). Versions are read from the
 * screen, never assumed: the alias rows move to new versions over time.
 */
import { CLAUDE_DIALOG_ENV } from '@emberline/adapter-claude';
import { MODEL_ID_RE } from '@emberline/protocol';
import type { PickerScript } from '../picker.js';
import { PickerParseError } from './errors.js';

export type PickerModel = { id: string; label: string; description: string; group?: string };

/** The families Claude Code accepts as a bare alias for `--model`. */
const ALIASES = new Set(['opus', 'fable', 'sonnet', 'haiku']);

/**
 * The env Claude Code runs with for the probe, as runs set it: no folder-trust question, no surveys
 * or cost prompts, and no auto-update. The updater would write the shared tools volume under live
 * runs, and the probe is ended seconds after it starts, which could cut an update off halfway.
 */
export const CLAUDE_PROBE_ENV: Record<string, string> = {
  // Skips the folder-trust question in any folder, so the probe's folder name does not matter.
  CLAUDE_CODE_SANDBOXED: '1',
  DISABLE_AUTOUPDATER: '1',
  ...CLAUDE_DIALOG_ENV,
};

export const CLAUDE_PICKER: PickerScript = {
  // Read when the job starts, so the override is honoured like a run's Claude command is.
  get command() {
    return {
      file: process.env.EMBERLINE_CLAUDE_COMMAND?.trim() || 'claude',
      args: [],
      env: CLAUDE_PROBE_ENV,
    };
  },
  // The prompt line, empty or showing Claude's dim placeholder (`Try "…"`). The cell after ❯ is a
  // no-break space. Anything typed (`/model`, `/exit`) replaces the placeholder and never matches,
  // so the reader only ever types at an empty prompt.
  ready: /^❯[ \u00a0]*(?:Try "[^"\n]*")?$/m,
  picker: /Select model/,
  groupRow: /More models/,
  // The picker's cursor sits before a numbered row or the More models row. The group's arrow, if
  // any, is any one glyph: only the open group's `▾` has been seen, and a collapsed one may draw
  // `▸`, `▶` or `›`. Claude's own prompt (`❯`, `❯ /model`) and the slash-command menu (`❯ /model  Set the AI
  // model…`) never match.
  cursorRow: /^\s*❯\s*(?:\d+\.|(?:[^\s\w]\s+)?More models)/,
  exit: '/exit',
  // A start after an update shows its release notes first and can take ~10 s before the prompt.
  stepTimeoutMs: 20_000,
};

const ROW = /^\s*(?:❯\s*)?\d+\.\s+(.*)$/;
const VERSIONED = /^([A-Za-z]+)\s+(\d+(?:\.\d+)*)$/;
const BARE = /^([A-Za-z]+)$/;
const SEP = ' · ';

/** A row's name and description, which the picker lays out as columns at least two cells apart. */
function splitRow(rest: string): { name: string; description: string } {
  const gap = /\s{2,}/.exec(rest);
  const name = (gap ? rest.slice(0, gap.index) : rest).replace(/✔/g, '').trim();
  const description = gap ? rest.slice(gap.index).trim() : '';
  return { name, description };
}

function rowModel(name: string, description: string, inGroup: boolean): PickerModel | undefined {
  if (/^Default\b/.test(name)) return undefined;
  const versioned = VERSIONED.exec(name);
  if (inGroup) {
    if (!versioned) return undefined;
    const [, family, version] = versioned;
    return {
      id: `claude-${family!.toLowerCase()}-${version!.replace(/\./g, '-')}`,
      label: name,
      description,
      group: 'more',
    };
  }

  const family = versioned?.[1] ?? BARE.exec(name)?.[1];
  if (family === undefined) return undefined;
  let version = versioned?.[2];
  let text = description;
  // Signed out, the version is the description's first part ("Opus 5.5 · Best for …").
  const [first, ...rest] = description.split(SEP);
  const lead = first ? VERSIONED.exec(first.trim()) : null;
  if (lead && lead[1] === family) {
    version ??= lead[2];
    text = rest.join(SEP).trim();
  }
  const label = version ? `${family} ${version}` : family;
  if (ALIASES.has(family.toLowerCase())) return { id: family.toLowerCase(), label, description: text };
  // A family Claude Code has no alias for is only reachable by its full name.
  if (!version) return undefined;
  return { id: `claude-${family.toLowerCase()}-${version.replace(/\./g, '-')}`, label, description: text };
}

/** The models on the picker's screens, in screen order; the first row per id wins. */
export function parseClaudePicker(screens: string[]): PickerModel[] {
  const out: PickerModel[] = [];
  const seen = new Set<string>();
  for (const screen of screens) {
    const lines = screen.replace(/\u00a0/g, ' ').split('\n');
    // Only what follows the picker's title, when it shows: the transcript above can hold anything.
    const title = lines.findLastIndex((l) => CLAUDE_PICKER.picker.test(l));
    let inGroup = false;
    for (const line of lines.slice(title + 1)) {
      if (CLAUDE_PICKER.groupRow.test(line)) {
        inGroup = true;
        continue;
      }
      const row = ROW.exec(line);
      if (!row) continue;
      const { name, description } = splitRow(row[1]!);
      const model = rowModel(name, description, inGroup);
      if (!model || !MODEL_ID_RE.test(model.id) || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push(model);
    }
  }
  if (out.length === 0)
    throw new PickerParseError("Claude Code's model picker showed no model rows it could read");
  return out;
}
