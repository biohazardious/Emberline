/**
 * The `emberline` MCP server: one tool, `ticket_complete`, with which an agent tells Emberline its
 * ticket is finished (or blocked). It posts to core with the same per-run token the hooks use.
 * Failures come back as tool errors; nothing here may crash the CLI that launched the server.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const TIMEOUT_MS = 15_000;
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

const toolError = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });
const toolText = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const HTTP_MESSAGES: Record<number, string> = {
  400: 'Emberline rejected the signal (invalid fields).',
  401: 'Emberline rejected the token for this run.',
  404: 'Emberline does not know this run.',
  409: 'This run has already ended; the signal was not recorded.',
};

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

  return server;
}
