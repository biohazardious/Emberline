/**
 * Which command lists a provider's models, and parsers for what those commands print. The runner
 * runs the commands; this file only knows the formats.
 */
import { type AgentId, MODEL_ID_RE } from '@emberline/protocol';

type Listed = { id: string; label: string };

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

/** `aider --list-models <prefix>` prints a header, then `- <id>` lines; anything else is noise. */
export function parseAiderModels(text: string, prefixes: string[]): Listed[] {
  const entries: Listed[] = [];
  for (const line of lines(text)) {
    if (!line.startsWith('- ')) continue;
    const id = line.slice(2).trim();
    if (prefixes.some((p) => id.startsWith(p))) entries.push({ id, label: id });
  }
  return collect(entries);
}

export function listCommandsFor(
  agent: AgentId,
  opts: { aiderPrefixes: string[] },
): { file: string; args: string[] }[] {
  if (agent === 'antigravity') {
    const file = process.env.EMBERLINE_ANTIGRAVITY_COMMAND?.trim() || 'agy';
    return [{ file, args: ['--log-file', '/dev/null', 'models'] }];
  }
  if (agent === 'aider') {
    return opts.aiderPrefixes.map((p) => ({ file: 'aider', args: ['--list-models', p] }));
  }
  return [];
}
