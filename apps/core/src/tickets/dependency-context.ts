import { clipText } from '../text/control-chars.js';

/** A direct dependency of a starting ticket that carries the agent's completion signal. */
export interface FinishedDependency {
  key: string;
  title: string;
  completion: { summary: string; handoff: string; blockers?: string[]; at: string };
}

/** Longest block one dependency may take in the section (heading included). */
export const DEPENDENCY_BLOCK_MAX = 3000;
/** Longest the whole section may be (its heading included). */
export const DEPENDENCY_SECTION_MAX = 10_000;

const HEADING = '## Context from finished dependencies';
const SEPARATOR = '\n\n';
const ELLIPSIS = '…';

/** Cut to `max` with an ellipsis, never splitting a surrogate pair. */
const clip = clipText;

/**
 * The prompt section handing the finished dependencies' summary, handoff and any blockers they
 * reported to a dependent ticket,
 * oldest completion first. Each dependency is capped at {@link DEPENDENCY_BLOCK_MAX}; when the
 * section would exceed `max` (default {@link DEPENDENCY_SECTION_MAX}) the oldest dependencies are
 * shortened first, down to their heading. Empty when there is nothing to hand over or not even the
 * headings fit.
 */
export function dependencyContextSection(deps: FinishedDependency[], max = DEPENDENCY_SECTION_MAX): string {
  if (deps.length === 0) return '';
  const ordered = [...deps].sort((a, b) => a.completion.at.localeCompare(b.completion.at));
  const headings = ordered.map((dep) => `### ${dep.key}: ${dep.title}`);
  const blocks = ordered.map((dep, i) => {
    const lines = [headings[i] as string, `Summary: ${dep.completion.summary.trim()}`];
    const handoff = dep.completion.handoff.trim();
    if (handoff) lines.push(`Handoff: ${handoff}`);
    const blockers = (dep.completion.blockers ?? []).map((b) => b.trim()).filter(Boolean);
    if (blockers.length > 0) lines.push(`Blockers: ${blockers.join('; ')}`);
    return clip(lines.join('\n'), DEPENDENCY_BLOCK_MAX);
  });
  const total = () => HEADING.length + blocks.reduce((sum, block) => sum + SEPARATOR.length + block.length, 0);
  let excess = total() - max;
  for (let i = 0; i < blocks.length && excess > 0; i += 1) {
    const block = blocks[i] as string;
    // Down to the heading plus "\n…" at the shortest; a heading alone still names the dependency.
    const floor = (headings[i] as string).length + 1 + ELLIPSIS.length;
    if (block.length <= floor) continue;
    const target = Math.max(floor, block.length - excess);
    const heading = headings[i] as string;
    blocks[i] = target === floor ? `${heading}\n${ELLIPSIS}` : clip(block, target);
    excess = total() - max;
  }
  if (excess > 0) return '';
  return [HEADING, ...blocks].join(SEPARATOR);
}
