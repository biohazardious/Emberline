import { RUN_PROMPT_MAX } from '@emberline/protocol';
import { HttpError } from '../errors.js';
import { clipText } from '../text/control-chars.js';

/** The prompt a run continues with after another session stopped (quota handoff or a fresh resume). */
export interface HandoffPromptInput {
  ticket: { key: string; title: string; body: string } | null;
  originalPrompt: string;
  from: { agent: string; model: string | null };
  reason: string;
  finalMessage: string | null;
  gitStatus: string;
  diffStat: string;
  recentTools: string[];
  sameAgent: boolean;
}

const MAX_SECTION = 4_000;
const clip = (text: string) => (text.length > MAX_SECTION ? `${text.slice(0, MAX_SECTION)}\n…` : text);

/**
 * The tool-call lines for a handoff prompt: details on one line, consecutive repeats folded
 * ("Edit ×3"). Empty when no call has a detail, since the worktree status already shows what changed.
 */
export function summarizeRecentTools(calls: { name: string; detail: string }[]): string[] {
  if (!calls.some((c) => c.detail.trim())) return [];
  const lines: { text: string; count: number }[] = [];
  for (const call of calls) {
    const detail = call.detail.replace(/\s+/g, ' ').trim();
    const text = detail ? `${call.name}: ${detail}` : call.name;
    const last = lines.at(-1);
    if (last?.text === text) last.count += 1;
    else lines.push({ text, count: 1 });
  }
  return lines.map((l) => (l.count > 1 ? `${l.text} ×${l.count}` : l.text));
}

/** The handoff prompt's last paragraph; it always stays. */
const CLOSING =
  'Check the current state of the files first, keep the work that is already done, do not redo finished steps, and complete the task.';

/** `text` cut to its last `max` characters, marked with a leading ellipsis when cut. */
const clipStart = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - Math.max(0, max - 1))}`;

/**
 * The prompt a run continues with, at most `max` characters. Over it, the middle gives way and the
 * opening, the worktree state and the closing instruction stay: first the task (the ticket has it
 * in full) and the last message are shortened, then the tool calls (the newest kept), and the
 * worktree state last of all.
 */
export function buildHandoffPrompt(input: HandoffPromptInput, max = Number.POSITIVE_INFINITY): string {
  const who = `${input.from.agent}${input.from.model ? ` (${input.from.model})` : ''}`;
  const task = input.ticket
    ? `${input.ticket.key}: ${input.ticket.title}${input.ticket.body.trim() ? `\n\n${input.ticket.body.trim()}` : ''}`
    : input.originalPrompt;
  const opening = input.sameAgent
    ? `Your previous session on this task ended (${input.reason}). You are in the same worktree; continue the task.`
    : `You are taking over a task from another agent, ${who}, which stopped: ${input.reason}. You are in the same worktree and branch it was working in.`;
  const tree = [input.gitStatus.trim(), input.diffStat.trim()].filter(Boolean).join('\n\n');
  // In prompt order; `rank` is the order in which they give way, `shorten` how.
  const sections: {
    heading: string;
    body: string;
    rank: number;
    shorten: (text: string, max: number) => string;
  }[] = [{ heading: '## Task', body: clip(task), rank: 0, shorten: clipText }];
  if (input.finalMessage?.trim()) {
    sections.push({
      heading: `## Last message from ${who}`,
      body: clip(input.finalMessage.trim()),
      rank: 1,
      shorten: clipText,
    });
  }
  sections.push({
    heading: '## Worktree state',
    body: tree ? clip(tree) : 'No changes in the worktree yet.',
    rank: 3,
    shorten: clipText,
  });
  if (input.recentTools.length > 0) {
    const body = input.recentTools.map((t) => `- ${t}`).join('\n');
    sections.push({ heading: '## Recent tool calls (oldest first)', body, rank: 2, shorten: clipStart });
  }
  const render = () => [opening, ...sections.map((s) => `${s.heading}\n\n${s.body}`), CLOSING].join('\n\n');
  let text = render();
  for (const section of [...sections].sort((a, b) => a.rank - b.rank)) {
    const over = text.length - max;
    if (over <= 0) break;
    section.body = section.shorten(section.body, Math.max(1, section.body.length - over));
    text = render();
  }
  return text.length > max ? clipText(text, max) : text;
}

/** The least of the handoff context a successor's prompt keeps next to a person's text. */
const MIN_CONTEXT = 2_000;

/**
 * A successor's prompt within `max` (the run prompt limit): the handoff context, then the person's
 * text whole; the context gives way to the room left (see {@link buildHandoffPrompt}). 400
 * `prompt_too_long` when the text would leave the context less than {@link MIN_CONTEXT} characters.
 */
export function successorPrompt(input: HandoffPromptInput, extra: string, max = RUN_PROMPT_MAX): string {
  if (!extra) return buildHandoffPrompt(input, max);
  assertSuccessorExtraFits(extra, max);
  return `${buildHandoffPrompt(input, max - extra.length - 2)}\n\n${extra}`;
}

/** {@link successorPrompt}'s 400 `prompt_too_long`, for a caller that checks before acting. */
export function assertSuccessorExtraFits(extra: string, max = RUN_PROMPT_MAX): void {
  if (max - extra.length - 2 < MIN_CONTEXT) {
    throw new HttpError(
      400,
      'prompt_too_long',
      `The prompt is too long to send with the run's handoff context. Keep it under ${max - MIN_CONTEXT - 2} characters.`,
    );
  }
}
