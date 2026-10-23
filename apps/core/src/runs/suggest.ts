/** Suggest an answer: Claude drafts the person's reply, read-only, in the run's worktree. */
import { resolveClaudeCliModelFlag } from '@emberline/adapter-claude';
import type { AgentModelId, RunQuestion } from '@emberline/protocol';
import { execCommand } from '../command-exec.js';
import { HttpError } from '../errors.js';
import { clipCodeUnits } from '../text/control-chars.js';

export const SUGGEST_TIMEOUT_MS = 60_000;
const CLIP = 8_000;
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
});

const clip = (s: string | null) => (s && s.length > CLIP ? `${clipCodeUnits(s, CLIP)}…` : (s ?? ''));

export function buildSuggestPrompt(input: {
  ticketTitle: string | null;
  ticketBody: string | null;
  question: Pick<RunQuestion, 'kind' | 'text' | 'options'>;
  lastMessage: string | null;
}): string {
  const parts = [
    'You draft the reply a person will send to an AI coding agent that is waiting for them. Write only the reply, short and concrete, in the language of the question.',
    'Pick one of the offered options when one fits. Say what you do not know instead of inventing facts. You may read files in this directory. Never print secrets, tokens or environment values.',
  ];
  if (input.ticketTitle) parts.push(`Ticket: ${input.ticketTitle}`);
  if (input.ticketBody) parts.push(`Ticket description:\n${clip(input.ticketBody)}`);
  parts.push(
    input.question.kind === 'blocked'
      ? `The agent reported these blockers:\n${input.question.text}`
      : `The agent asks:\n${clip(input.question.text)}`,
  );
  if (input.question.options.length > 0)
    parts.push(
      `Options the agent offered:\n${input.question.options.map((o) => `- ${o.label}${o.detail ? `: ${o.detail}` : ''}`).join('\n')}`,
    );
  if (input.lastMessage && input.lastMessage !== input.question.text)
    parts.push(`The agent's last message:\n${clip(input.lastMessage)}`);
  return parts.join('\n\n');
}

export async function runSuggestion(params: {
  command: string;
  model: string;
  cwd: string;
  prompt: string;
}): Promise<string> {
  const model = resolveClaudeCliModelFlag(params.model as AgentModelId) ?? params.model;
  const result = await execCommand({
    file: params.command,
    args: [
      '-p',
      params.prompt,
      '--output-format',
      'json',
      '--json-schema',
      SCHEMA,
      '--permission-mode',
      'plan',
      '--no-session-persistence',
      '--model',
      model,
    ],
    cwd: params.cwd,
    timeoutMs: SUGGEST_TIMEOUT_MS,
  });
  if (result.timedOut)
    throw new HttpError(
      504,
      'suggest_timeout',
      'The suggestion took too long. Write the answer yourself or try again.',
    );
  // `--output-format json` prints one result envelope; an error (a usage limit, a bad key) is its `result`.
  const envelope = parseEnvelope(result.stdout);
  const answer = envelope?.structured_output?.answer;
  if (envelope && !envelope.is_error && typeof answer === 'string' && answer.trim()) return answer.trim();
  const said = envelope
    ? typeof envelope.result === 'string'
      ? envelope.result.trim()
      : ''
    : ((result.stderr || result.stdout).trim().split('\n').at(-1) ?? '');
  const reason = said.length > 200 ? `${clipCodeUnits(said, 200)}…` : said;
  throw new HttpError(
    502,
    'suggest_failed',
    `Claude could not suggest an answer${reason ? `: ${reason}` : '.'}`,
  );
}

interface ResultEnvelope {
  is_error?: unknown;
  result?: unknown;
  structured_output?: { answer?: unknown };
}

/** The CLI's JSON result, or null when stdout is not one. */
function parseEnvelope(stdout: string): ResultEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return parsed && typeof parsed === 'object' ? (parsed as ResultEnvelope) : null;
  } catch {
    return null;
  }
}
