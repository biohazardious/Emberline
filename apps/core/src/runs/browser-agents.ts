export const BROWSER_AGENT_WINDOW_MS = 60_000;

/** A tool call that drives a browser: Playwright MCP, or a Bash command that runs Playwright or Chromium. */
export function isBrowserToolCall(toolName: string, detail: string): boolean {
  return (
    toolName.startsWith('mcp__playwright__') || (toolName === 'Bash' && /playwright|chromium/i.test(detail))
  );
}

export interface BrowserToolCall {
  projectId: string;
  toolName: string;
  detail: string;
  at: number;
}

/** Projects with a browser tool call in the last BROWSER_AGENT_WINDOW_MS before `now`. */
export function browserAgentProjects(calls: readonly BrowserToolCall[], now: number): Set<string> {
  const ids = new Set<string>();
  for (const c of calls) {
    if (now - c.at <= BROWSER_AGENT_WINDOW_MS && isBrowserToolCall(c.toolName, c.detail))
      ids.add(c.projectId);
  }
  return ids;
}
