#!/usr/bin/env node
/**
 * emberline-mcp: stdio MCP server exposing the `ticket_complete` and `preview` tools to Claude Code.
 *
 * On startup it checks in with core (`POST /api/internal/runs/:id/completion-tool`), so the
 * completion gate only waits for the tool in runs whose agent actually has it.
 *
 * Env (set by Emberline on the CLI process, passed through the MCP config):
 *   EMBERLINE_RUN_ID, EMBERLINE_HOOK_TOKEN, EMBERLINE_CORE_URL
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { announceCompletionTool, createEmberlineMcpServer } from './mcp-server.js';

createEmberlineMcpServer()
  .connect(new StdioServerTransport())
  // Connected: the CLI has the tool now. The check-in is best effort and never throws.
  .then(() => announceCompletionTool())
  .catch((err: unknown) => {
    process.stderr.write(`emberline-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
