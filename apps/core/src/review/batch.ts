/**
 * The text of a request-changes batch: pure, so the wording is tested on its own. Comments are
 * grouped by priority; within a group come the new comments, then sent ones the run ended without
 * addressing, then addressed ones still pinned until a person resolves them.
 */
import type { ReviewComment } from '@emberline/protocol';
import { stripControlChars } from '../text/control-chars.js';

/** Why a comment is in the batch: not sent yet, sent but never addressed, or addressed and not yet verified. */
export type BatchKind = 'new' | 'reminder' | 'pinned';

export type BatchComment = Pick<
  ReviewComment,
  'id' | 'filePath' | 'line' | 'currentLine' | 'outdated' | 'side' | 'intent' | 'priority' | 'body' | 'anchorText'
> & { kind: BatchKind };

const GROUPS: { priority: ReviewComment['priority']; heading: string }[] = [
  { priority: 'blocking', heading: 'Blocking — Must be fixed before this can merge:' },
  { priority: 'important', heading: 'Important:' },
  { priority: 'suggestion', heading: 'Suggestions:' },
];

const KINDS: { kind: BatchKind; heading: string | null }[] = [
  { kind: 'new', heading: null },
  { kind: 'reminder', heading: 'From the previous round — not yet addressed:' },
  { kind: 'pinned', heading: 'From the previous round — please check this is done:' },
];

/** A Markdown code span that survives backticks inside `text`. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** One line of the prompt for paths and code: no controls at all, not even a newline. */
const oneLine = (text: string) => stripControlChars(text, '');

function commentLine(c: BatchComment): string {
  const filePath = oneLine(c.filePath);
  let where: string;
  if (c.line === null) where = `${code(filePath)} (whole file)`;
  else if (c.outdated) {
    const anchor = c.anchorText ? oneLine(c.anchorText) : '';
    const was = anchor ? `was at line ${c.line}: ${code(anchor)}` : `was at line ${c.line}`;
    where = `${code(filePath)} (${was})`;
  } else where = code(`${filePath}:${c.currentLine ?? c.line}`);
  if (c.side === 'original') where += ' (removed code)';
  const body = stripControlChars(c.body.trim().replace(/\r\n?/g, '\n')).replace(/\n/g, '\n  ');
  return `- ${where} (${c.intent}) ${body}`;
}

const byPlace = (a: BatchComment, b: BatchComment) =>
  a.filePath.localeCompare(b.filePath) || (a.currentLine ?? a.line ?? 0) - (b.currentLine ?? b.line ?? 0);

/** The note and the priority groups; `rounds` adds the previous-round headings within a group. */
function feedback(note: string, comments: BatchComment[], rounds: boolean): string[] {
  const lines: string[] = [];
  const cleanNote = stripControlChars(note.trim());
  if (cleanNote) lines.push(`Overall note: ${cleanNote}`);
  for (const group of GROUPS) {
    const inGroup = comments.filter((c) => c.priority === group.priority);
    if (inGroup.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(group.heading);
    if (!rounds) {
      lines.push(...[...inGroup].sort(byPlace).map(commentLine));
      continue;
    }
    for (const { kind, heading } of KINDS) {
      const ofKind = inGroup.filter((c) => c.kind === kind).sort(byPlace);
      if (ofKind.length === 0) continue;
      if (heading) lines.push(heading);
      lines.push(...ofKind.map(commentLine));
    }
  }
  return lines;
}

/** The prompt typed into (or resumed by) the run the comments were written on. */
export function sameRunPrompt(note: string, comments: BatchComment[]): string {
  return ['Please address the following code review feedback on this branch:', '', ...feedback(note, comments, true)].join('\n');
}

const priorityRank = (c: BatchComment) => GROUPS.findIndex((g) => g.priority === c.priority);

/**
 * The section appended to a fresh run's ticket prompt, carrying the feedback on an earlier run,
 * within `max` characters: whole comments only, Blocking first, then Important, then Suggestions,
 * with "(n more comments not included)" when some are left out. `included` are the comments it
 * carries. Null when the heading and note leave no room, or when there are comments and not even
 * one of them fits.
 */
export function newRunFeedbackSection(
  previousRunId: string,
  note: string,
  comments: BatchComment[],
  max = Number.POSITIVE_INFINITY,
): { text: string; included: BatchComment[] } | null {
  const ordered = [...comments].sort((a, b) => priorityRank(a) - priorityRank(b) || byPlace(a, b));
  const render = (taken: BatchComment[]) => {
    const left = ordered.length - taken.length;
    const lines = [
      `## Review feedback from the previous attempt (run ${previousRunId.slice(0, 8)})`,
      '',
      "A person reviewed an earlier attempt at this ticket. That attempt's changes are not in this worktree (it starts from the default branch); the paths and lines below refer to it. Take this feedback into account as you do the ticket.",
      '',
      ...feedback(note, taken, false),
    ];
    if (left > 0) lines.push('', `(${left} more comment${left === 1 ? '' : 's'} not included)`);
    return lines.join('\n');
  };
  for (let n = ordered.length; n >= 0; n -= 1) {
    if (n === 0 && ordered.length > 0) return null;
    const taken = ordered.slice(0, n);
    const text = render(taken);
    if (text.length <= max) return { text, included: taken };
  }
  return null;
}
