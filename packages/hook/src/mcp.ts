#!/usr/bin/env node
/**
 * emberline-mcp: stdio MCP server exposing the `ticket_complete` tool to Claude Code.
 *
 * Env (set by Emberline on the CLI process, passed through the MCP config):
 *   EMBERLINE_RUN_ID, EMBERLINE_HOOK_TOKEN, EMBERLINE_CORE_URL
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEmberlineMcpServer } from './mcp-server.js';

createEmberlineMcpServer()
  .connect(new StdioServerTransport())
  .catch((err: unknown) => {
    process.stderr.write(`emberline-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
