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

export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const who = `${input.from.agent}${input.from.model ? ` (${input.from.model})` : ''}`;
  const task = input.ticket
    ? `${input.ticket.key}: ${input.ticket.title}${input.ticket.body.trim() ? `\n\n${input.ticket.body.trim()}` : ''}`
    : input.originalPrompt;
  const parts = [
    input.sameAgent
      ? `Your previous session on this task ended (${input.reason}). You are in the same worktree; continue the task.`
      : `You are taking over a task from another agent, ${who}, which stopped: ${input.reason}. You are in the same worktree and branch it was working in.`,
    `## Task\n\n${clip(task)}`,
  ];
  if (input.finalMessage?.trim()) parts.push(`## Last message from ${who}\n\n${clip(input.finalMessage.trim())}`);
  const tree = [input.gitStatus.trim(), input.diffStat.trim()].filter(Boolean).join('\n\n');
  parts.push(`## Worktree state\n\n${tree ? clip(tree) : 'No changes in the worktree yet.'}`);
  if (input.recentTools.length > 0) {
    parts.push(`## Recent tool calls (oldest first)\n\n${input.recentTools.map((t) => `- ${t}`).join('\n')}`);
  }
  parts.push(
    'Check the current state of the files first, keep the work that is already done, do not redo finished steps, and complete the task.',
  );
  return parts.join('\n\n');
}
