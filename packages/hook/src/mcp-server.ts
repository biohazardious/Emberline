/**
 * The `emberline` MCP server. `ticket_complete`: an agent tells Emberline its ticket is finished (or
 * blocked). `preview`: it starts its run's own preview and gets the URL to open in the browser. Both
 * post to core with the same per-run token the hooks use, for the run in the env (never one given in
 * the arguments). Failures come back as tool errors; nothing here may crash the CLI that launched it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const TIMEOUT_MS = 15_000;
/** Core waits up to 5 min for a container preview (AGENT_PREVIEW_WAIT_MS), then answers `starting`. */
const PREVIEW_TIMEOUT_MS = 6 * 60_000;
/** While the preview call waits: progress keeps a client that resets its timeout on progress waiting. */
const PROGRESS_EVERY_MS = 10_000;
/** The startup check-in must never hold anything up. */
const CHECK_IN_TIMEOUT_MS = 5_000;
const LIMITS = { summary: 4000, handoff: 8000, blockers: 10, blocker: 500 } as const;

/** Inputs are cut to core's limits here so a long note is trimmed rather than refused. */
const inputShape = {
  summary: z.string().describe('What was done, in a few sentences.'),
  handoff: z
    .string()
    .optional()
    .describe('What whoever builds on this next needs to know: APIs added, files, follow-ups.'),
  blockers: z
    .array(z.string())
    .optional()
    .describe('Why the ticket cannot be finished. Non-empty means "not done, a person must look".'),
};

/** Core's answer (`AgentPreviewResponse` in @emberline/protocol, kept local so the server needs no build of it). */
const PreviewAnswer = z.object({
  status: z.enum(['stopped', 'starting', 'running', 'exited', 'failed', 'unavailable']),
  url: z.string().nullable(),
  kind: z.enum(['compose', 'command', 'static']),
  error: z.string().optional(),
  logs: z.string().optional(),
  note: z.string().optional(),
});
type PreviewAnswer = z.infer<typeof PreviewAnswer>;

const PREVIEW_HTTP_MESSAGES: Record<number, string> = {
  400: 'Emberline rejected the request (invalid fields).',
  401: 'Emberline rejected the token for this run.',
  404: 'Emberline does not know this run.',
  409: 'This run has already ended; no preview was started.',
};

/** What the agent reads: the next step in a sentence or two, then the whole answer as JSON. */
export function describePreview(answer: PreviewAnswer): string {
  const fallback = answer.url
    ? ` Open ${answer.url} instead (${answer.kind === 'static' ? "this run's static build" : `the ${answer.kind} preview`}).`
    : ' Build the project and open $EMBERLINE_DEMO_URL instead.';
  let lead: string;
  if (answer.status === 'running' && answer.url && answer.kind !== 'static') {
    lead = `The preview is running (${answer.kind}). Open ${answer.url} in the browser; it serves this run's own work.${
      answer.kind === 'command'
        ? ' The dev server may take a few seconds to listen: retry the navigation if the connection is refused.'
        : ''
    }`;
  } else if (answer.status === 'starting') {
    lead = `The preview is still starting (a container build can take minutes); call \`preview\` again in a minute.${
      answer.url ? ` Meanwhile ${answer.url} serves this run's static build.` : ''
    }`;
  } else if (answer.status === 'unavailable') {
    lead = `No preview can run: ${answer.error ?? 'unknown reason'}.${fallback}`;
  } else {
    lead = `The preview ${answer.status === 'failed' ? 'failed' : `is ${answer.status}`}: ${answer.error ?? 'no reason given'}.${fallback}${
      answer.status === 'failed' ? ' Call `preview` again once it is fixed.' : ''
    }`;
  }
  const notes = answer.note ? `\nNote: ${answer.note}` : '';
  const logs = answer.logs ? `\nLogs (end):\n${answer.logs}` : '';
  return `${lead}${notes}${logs}\n\n${JSON.stringify(answer)}`;
}

const toolError = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });
const toolText = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const HTTP_MESSAGES: Record<number, string> = {
  400: 'Emberline rejected the signal (invalid fields).',
  401: 'Emberline rejected the token for this run.',
  404: 'Emberline does not know this run.',
  409: 'This run has already ended; the signal was not recorded.',
};

/**
 * Tells core on startup that this run's agent has the `ticket_complete` tool, so the completion gate
 * may wait for it (a run whose server never checked in advances the old way). Best effort: a failure
 * only goes to `log` (stderr), never throws. Resolves whether core recorded it.
 */
export async function announceCompletionTool(
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = (m) => process.stderr.write(m),
): Promise<boolean> {
  const runId = env.EMBERLINE_RUN_ID;
  const token = env.EMBERLINE_HOOK_TOKEN;
  if (!runId || !token) return false;
  const base = env.EMBERLINE_CORE_URL || 'http://127.0.0.1:7420';
  try {
    const res = await fetch(
      new URL(`/api/internal/runs/${encodeURIComponent(runId)}/completion-tool`, base),
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CHECK_IN_TIMEOUT_MS),
      },
    );
    if (res.ok) return true;
    log(`emberline-mcp: check-in failed: HTTP ${res.status}\n`);
  } catch (err) {
    log(`emberline-mcp: check-in failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return false;
}

export function createEmberlineMcpServer(env: Record<string, string | undefined> = process.env): McpServer {
  const server = new McpServer({ name: 'emberline', version: '1.0.0' });

  server.registerTool(
    'ticket_complete',
    {
      title: 'Signal ticket completion',
      description:
        'Tell Emberline this ticket is finished and its work is saved in the worktree. Give a short summary and a handoff note for whoever builds on it. If the ticket cannot be finished, pass blockers instead. Do not call it while waiting for an answer from a person.',
      inputSchema: inputShape,
    },
    async (args) => {
      const runId = env.EMBERLINE_RUN_ID;
      const token = env.EMBERLINE_HOOK_TOKEN;
      if (!runId || !token) return toolError('not running under Emberline');
      const base = env.EMBERLINE_CORE_URL || 'http://127.0.0.1:7420';
      const blockers = (args.blockers ?? [])
        .map((b) => b.trim().slice(0, LIMITS.blocker))
        .filter((b) => b.length > 0)
        .slice(0, LIMITS.blockers);
      const body = {
        summary: args.summary.trim().slice(0, LIMITS.summary),
        handoff: (args.handoff ?? '').slice(0, LIMITS.handoff),
        blockers,
      };
      let res: Response;
      try {
        res = await fetch(new URL(`/api/internal/runs/${encodeURIComponent(runId)}/complete`, base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        return toolError(`Could not reach Emberline: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) return toolError(HTTP_MESSAGES[res.status] ?? `Emberline answered HTTP ${res.status}.`);
      return toolText(
        blockers.length > 0
          ? 'Recorded the blockers; a person will look at this ticket. Stop now.'
          : 'Recorded. Stop now; Emberline runs the checks and merges.',
      );
    },
  );

  server.registerTool(
    'preview',
    {
      title: "Start this run's preview",
      description:
        "Start this run's own preview (its worktree, never main) if it is not running, wait until it is up, and get the URL to open with the browser tools. Use it before checking a web app in the browser. If no preview can run, it says so and names the static build to open instead.",
      inputSchema: {
        restart: z
          .boolean()
          .optional()
          .describe(
            'Start it again even when it runs, e.g. after changing the code a container preview was built from. Ignored while a start is still going; at most one start every 30 s.',
          ),
      },
    },
    async (args, extra) => {
      const runId = env.EMBERLINE_RUN_ID;
      const token = env.EMBERLINE_HOOK_TOKEN;
      if (!runId || !token) return toolError('not running under Emberline');
      const base = env.EMBERLINE_CORE_URL || 'http://127.0.0.1:7420';
      const progressToken = extra._meta?.progressToken;
      let ticks = 0;
      const progress =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              if (extra.signal.aborted) return;
              ticks += 1;
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: ticks, message: 'waiting for the preview to come up' },
                })
                .catch(() => undefined);
            }, PROGRESS_EVERY_MS);
      let res: Response;
      try {
        res = await fetch(new URL(`/api/internal/runs/${encodeURIComponent(runId)}/preview`, base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(args.restart ? { restart: true } : {}),
          // A cancelled tool call stops waiting (and its progress stops with it).
          signal: AbortSignal.any([extra.signal, AbortSignal.timeout(PREVIEW_TIMEOUT_MS)]),
        });
      } catch (err) {
        return toolError(`Could not reach Emberline: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearInterval(progress);
      }
      if (!res.ok)
        return toolError(PREVIEW_HTTP_MESSAGES[res.status] ?? `Emberline answered HTTP ${res.status}.`);
      const parsed = PreviewAnswer.safeParse(await res.json().catch(() => null));
      if (!parsed.success) return toolError('Emberline answered with an unexpected preview response.');
      return toolText(describePreview(parsed.data));
    },
  );

  return server;
}
