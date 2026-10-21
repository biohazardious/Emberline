import { describe, expect, it } from 'vitest';
import { BROWSER_AGENT_WINDOW_MS, browserAgentProjects, isBrowserToolCall } from './runs/browser-agents.js';

describe('browser agents', () => {
  it('Playwright MCP and Bash commands that run Playwright or Chromium drive a browser', () => {
    expect(isBrowserToolCall('mcp__playwright__browser_navigate', '')).toBe(true);
    expect(isBrowserToolCall('Bash', 'npx playwright test')).toBe(true);
    expect(isBrowserToolCall('Bash', 'chromium --headless')).toBe(true);
    expect(isBrowserToolCall('Bash', 'npm test')).toBe(false);
    expect(isBrowserToolCall('Edit', 'playwright.config.ts')).toBe(false);
  });
  it('projects with a browser call inside the window', () => {
    const now = 1_000_000;
    const ids = browserAgentProjects(
      [
        { projectId: 'a', toolName: 'mcp__playwright__browser_click', detail: '', at: now - 5_000 },
        {
          projectId: 'b',
          toolName: 'mcp__playwright__browser_click',
          detail: '',
          at: now - BROWSER_AGENT_WINDOW_MS - 1,
        },
        { projectId: 'c', toolName: 'Bash', detail: 'ls', at: now },
      ],
      now,
    );
    expect([...ids]).toEqual(['a']);
  });
});
