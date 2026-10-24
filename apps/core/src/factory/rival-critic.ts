/** Cross-provider review: a different AI CLI reviews a run's diff, read-only, in the runner. */
import path from 'node:path';
import { type AgentId, type AgentModelId, CrossCriticIssue } from '@emberline/protocol';
import { resolveClaudeCliModelFlag } from '@emberline/adapter-claude';
import { z } from 'zod';
import { execCommand, RUNNER_BIN, systemCommand } from '../command-exec.js';
import { execGitFile } from '../git-exec.js';
import { branchBase } from './slop-guard.js';

/** Total diff text handed to the reviewer; it can read more files itself (read-only tools). */
const MAX_DIFF_CHARS = 60_000;
const MAX_UNTRACKED_FILE_LINES = 200;
const REVIEW_TIMEOUT_MS = 5 * 60_000;

export const RivalReview = z.object({
  verdict: z.enum(['PASS', 'NEEDS_FIX']),
  score: z.number().min(0).max(100),
  summary: z.string().min(1),
  issues: z.array(CrossCriticIssue).max(50),
});
export type RivalReview = z.infer<typeof RivalReview>;

/** JSON schema the CLIs enforce on their final answer (`--json-schema`). */
export const RIVAL_REVIEW_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'NEEDS_FIX'] },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'nit'] },
          category: { type: 'string' },
          file: { type: 'string' },
          description: { type: 'string' },
          fixRecommendation: { type: 'string' },
        },
        required: ['severity', 'category', 'description', 'fixRecommendation'],
      },
    },
  },
  required: ['verdict', 'score', 'summary', 'issues'],
});

interface ReviewerCommand {
  file: string;
  args: string[];
}

/**
 * CLIs that can review non-interactively with a read-only mode and structured output. Both
 * print a JSON envelope whose `structured_output` holds the schema-checked answer.
 */
const REVIEWERS: Partial<Record<AgentId, (prompt: string, model: AgentModelId) => ReviewerCommand>> = {
  claude: (prompt, model) => {
    const cliModel = resolveClaudeCliModelFlag(model);
    return {
      file: process.env.EMBERLINE_CLAUDE_COMMAND?.trim() || 'claude',
      args: [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--json-schema',
        RIVAL_REVIEW_JSON_SCHEMA,
        // Plan mode: the reviewer may read files but never edit or run commands.
        '--permission-mode',
        'plan',
        '--no-session-persistence',
        ...(cliModel ? ['--model', cliModel] : []),
      ],
    };
  },
  antigravity: (prompt) => ({
    // The raw binary: the runner's `agy` wrapper rewrites -p for interactive runs.
    file:
      process.env.EMBERLINE_AGY_COMMAND?.trim() ||
      path.join(process.env.EMBERLINE_TOOLS_DIR ?? '/opt/ai-tools', 'bin', 'agy'),
    args: [
      '-p',
      prompt,
      '--mode',
      'plan',
      '--output-format',
      'json',
      '--json-schema',
      RIVAL_REVIEW_JSON_SCHEMA,
      '--effort',
      'high',
      '--print-timeout',
      `${Math.floor(REVIEW_TIMEOUT_MS / 1000) - 20}s`,
    ],
  }),
};

export function supportsRivalReview(agent: AgentId): boolean {
  return agent in REVIEWERS;
}

/** The run's changes against the branch it started from, plus untracked files, capped in size. */
export async function collectReviewDiff(
  workspacePath: string,
): Promise<{ diff: string; truncated: boolean }> {
  const git = (args: string[]) =>
    execGitFile(['-C', workspacePath, ...args], { timeout: 30_000 }).then((r) => r.stdout);
  const base = (await branchBase(workspacePath)) ?? 'HEAD';
  let diff = await git(['diff', '--no-color', base]).catch(() => '');
  const untracked = (await git(['ls-files', '--others', '--exclude-standard']).catch(() => ''))
    .split('\n')
    .filter(Boolean);
  for (const file of untracked) {
    if (diff.length > MAX_DIFF_CHARS) break;
    const text = await execCommand(
      systemCommand({
        file: RUNNER_BIN.head,
        args: ['-n', String(MAX_UNTRACKED_FILE_LINES), '--', file],
        cwd: workspacePath,
      }),
    )
      .then((r) => (r.exitCode === 0 ? r.stdout : ''))
      .catch(() => '');
    diff += `\n--- /dev/null\n+++ b/${file} (new, untracked)\n${text}`;
  }
  const truncated = diff.length > MAX_DIFF_CHARS;
  return { diff: truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff, truncated };
}

export function buildRivalPrompt(params: {
  authorAgent: AgentId;
  ticketTitle?: string | null;
  ticketBody?: string | null;
  diff: string;
}): string {
  return [
    `You are a strict senior code reviewer. Another AI coding agent (${params.authorAgent}) made the changes below in this repository.`,
    'Review them for correctness bugs, security problems, missing error handling, missing or weak tests, and changes that do not fit the task.',
    'Do NOT modify any files or run commands; you may read files in the repository for context.',
    'Return PASS only if nothing blocks merging. List every problem as an issue (severity critical|warning|nit, file as path:line when known) with a concrete fix recommendation. Score 0-100 for overall quality.',
    '',
    `Task: ${params.ticketTitle ?? '(no ticket)'}`,
    params.ticketBody ? `Task details:\n${params.ticketBody.slice(0, 4_000)}` : '',
    '',
    'Changes (git diff against the base branch):',
    '```diff',
    params.diff || '(no changes)',
    '```',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export type RivalReviewOutcome = { ok: true; review: RivalReview } | { ok: false; reason: string };

/** Runs the reviewer CLI once in the runner (via ptyd exec) and validates its structured answer. */
export async function runRivalReview(params: {
  reviewer: AgentId;
  model: AgentModelId;
  workspacePath: string;
  prompt: string;
}): Promise<RivalReviewOutcome> {
  const build = REVIEWERS[params.reviewer];
  if (!build) return { ok: false, reason: `${params.reviewer} has no non-interactive review mode` };
  const command = build(params.prompt, params.model);
  let result;
  try {
    result = await execCommand({
      file: command.file,
      args: command.args,
      cwd: params.workspacePath,
      timeoutMs: REVIEW_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (result.timedOut) return { ok: false, reason: `${params.reviewer} review timed out` };
  let envelope: { structured_output?: unknown; is_error?: boolean; status?: string };
  try {
    envelope = JSON.parse(result.stdout.trim()) as typeof envelope;
  } catch {
    const detail = (result.stderr || result.stdout).trim().split('\n').at(-1)?.slice(0, 200) ?? '';
    return {
      ok: false,
      reason: `${params.reviewer} exited ${result.exitCode}${detail ? `: ${detail}` : ''}`,
    };
  }
  if (envelope.is_error) return { ok: false, reason: `${params.reviewer} reported an error` };
  const parsed = RivalReview.safeParse(envelope.structured_output);
  if (!parsed.success) return { ok: false, reason: `${params.reviewer} returned no valid structured review` };
  return { ok: true, review: { ...parsed.data, score: Math.round(parsed.data.score) } };
}
