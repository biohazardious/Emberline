/**
 * Which command lists a provider's models, and parsers for what those commands print. The runner
 * runs the commands; this file only knows the formats.
 */
import { type AgentId, MODEL_ID_RE } from '@emberline/protocol';
import { PickerParseError } from './parsers/errors.js';

type Listed = { id: string; label: string; description?: string };

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/\r$/, '').trim());
}

/** Keeps the first entry per valid id so a repeated line cannot shadow the first label. */
function collect(entries: Iterable<Listed>): Listed[] {
  const seen = new Set<string>();
  const out: Listed[] = [];
  for (const e of entries) {
    if (!MODEL_ID_RE.test(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** `agy models` prints `id<TAB>label` lines after a "Fetching available models..." notice. */
export function parseAgyModels(text: string): Listed[] {
  const entries: Listed[] = [];
  for (const line of lines(text)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    entries.push({ id, label: label || id });
  }
  return collect(entries);
}

/**
 * `codex debug models` prints the signed-in account's model catalog as one JSON object,
 * `{"models":[…]}` (written against codex-cli 0.169.0). Only `visibility: "list"` entries are shown in
 * Codex's own `/model` picker; the others are internal (reviewers, reserved slots). Ordered as the
 * picker orders them, by `priority`.
 */
export function parseCodexModels(text: string): Listed[] {
  const models = codexCatalog(text);
  const listed = models
    .filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
    .map((m, i) => ({ m, i, priority: typeof m.priority === 'number' ? m.priority : Infinity }))
    .sort((a, b) => a.priority - b.priority || a.i - b.i)
    .map(({ m }) => {
      const id = String(m.slug).trim();
      const label = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : id;
      const description = typeof m.description === 'string' ? m.description.trim() : '';
      return { id, label, ...(description ? { description } : {}) };
    });
  return collect(listed);
}

type CodexModel = Record<string, unknown>;

/** The `models` array, also when a notice was printed around the JSON. */
function codexCatalog(text: string): CodexModel[] {
  const parse = (body: string): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  };
  let data = parse(text.trim());
  if (data === undefined) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) data = parse(text.slice(start, end + 1));
  }
  const models = (data as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) throw new PickerParseError('`codex debug models` printed no model catalog');
  return models.filter((m): m is CodexModel => !!m && typeof m === 'object');
}

/**
 * The copilot listing (`emberline-copilot-models.mjs`, which reads the models of an ACP session)
 * prints `id<TAB>name` lines. Copilot's own `auto` is dropped like Claude's "Default" row: Emberline's
 * `auto` already means "no `--model`, the CLI picks", and an `auto` catalog entry would shadow it.
 * Null when the CLI named nothing but `auto` (a free account): the read worked and found no models
 * of Copilot's own, which is not a failure.
 */
export function parseCopilotModels(text: string): Listed[] | null {
  let sawAuto = false;
  const entries: Listed[] = [];
  for (const line of lines(text)) {
    const tab = line.indexOf('\t');
    const id = (tab < 0 ? line : line.slice(0, tab)).trim();
    if (!id) continue;
    if (id === 'auto') {
      sawAuto = true;
      continue;
    }
    const label = tab < 0 ? '' : line.slice(tab + 1).trim();
    entries.push({ id, label: label || id });
  }
  const models = collect(entries);
  return models.length === 0 && sawAuto ? null : models;
}

/** The script (shipped in the runner's wrappers) that lists Copilot's models; see that file. */
export const COPILOT_MODELS_SCRIPT = 'emberline-copilot-models.mjs';

export function listCommandsFor(agent: AgentId): { file: string; args: string[] }[] {
  if (agent === 'antigravity') {
    const file = process.env.EMBERLINE_ANTIGRAVITY_COMMAND?.trim() || 'agy';
    return [{ file, args: ['--log-file', '/dev/null', 'models'] }];
  }
  if (agent === 'codex') {
    // Without `--bundled` the CLI refreshes the signed-in account's catalog first. The update check
    // is off as it is for runs, so no update notice lands in the output.
    const file = process.env.EMBERLINE_CODEX_COMMAND?.trim() || 'codex';
    return [{ file, args: ['-c', 'check_for_update_on_startup=false', 'debug', 'models'] }];
  }
  if (agent === 'copilot') {
    const copilot = process.env.EMBERLINE_COPILOT_COMMAND?.trim() || 'copilot';
    return [{ file: COPILOT_MODELS_SCRIPT, args: [copilot] }];
  }
  return [];
}
