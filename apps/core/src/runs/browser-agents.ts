import { browsableHref } from '../factory/browser-daemon.js';

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
  return new Set(browserAgentActivity(calls, now).keys());
}

export interface BrowserAgentActivity {
  /** The URL of the project's newest `browser_navigate` call in the window; null when none. */
  lastUrl: string | null;
}

/** The URL a Playwright MCP `browser_navigate` call opens, from its summary (`url: … · …`). */
function navigateUrl(c: BrowserToolCall): string | null {
  if (c.toolName !== 'mcp__playwright__browser_navigate') return null;
  const m = /^url: (.+?)(?: · |$)/.exec(c.detail);
  return m ? browsableHref(m[1]!) : null;
}

/**
 * Per project with a browser tool call in the last BROWSER_AGENT_WINDOW_MS before `now`: the URL
 * its agent navigated to last (the Live Browser follows the tab at that URL).
 */
export function browserAgentActivity(
  calls: readonly BrowserToolCall[],
  now: number,
): Map<string, BrowserAgentActivity> {
  const out = new Map<string, BrowserAgentActivity & { at: number }>();
  for (const c of calls) {
    if (now - c.at > BROWSER_AGENT_WINDOW_MS || !isBrowserToolCall(c.toolName, c.detail)) continue;
    const entry = out.get(c.projectId) ?? { lastUrl: null, at: -Infinity };
    const url = navigateUrl(c);
    if (url && c.at >= entry.at) {
      entry.lastUrl = url;
      entry.at = c.at;
    }
    out.set(c.projectId, entry);
  }
  return new Map([...out].map(([id, { lastUrl }]) => [id, { lastUrl }]));
}
