import { describe, expect, it } from 'vitest';
import {
  BROWSER_AGENT_WINDOW_MS,
  browserAgentActivity,
  browserAgentProjects,
  isBrowserToolCall,
} from './runs/browser-agents.js';

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

  it("each project's newest navigation in the window is its agent's URL", () => {
    const now = 1_000_000;
    const nav = 'mcp__playwright__browser_navigate';
    const activity = browserAgentActivity(
      [
        { projectId: 'a', toolName: nav, detail: 'url: http://localhost:5173/new', at: now - 1_000 },
        { projectId: 'a', toolName: nav, detail: 'url: http://localhost:5173/old · element: x', at: now - 9_000 },
        { projectId: 'a', toolName: 'mcp__playwright__browser_click', detail: 'element: Play', at: now },
        { projectId: 'b', toolName: 'mcp__playwright__browser_click', detail: 'element: Go', at: now },
        { projectId: 'c', toolName: nav, detail: 'url: http://x/', at: now - BROWSER_AGENT_WINDOW_MS - 1 },
      ],
      now,
    );
    expect([...activity]).toEqual([
      ['a', { lastUrl: 'http://localhost:5173/new' }],
      ['b', { lastUrl: null }],
    ]);
  });

  it('a navigation to a bare host or path gets http://, as the browser shows it', () => {
    const now = 1_000_000;
    const lastUrl = (detail: string) =>
      browserAgentActivity(
        [{ projectId: 'a', toolName: 'mcp__playwright__browser_navigate', detail, at: now }],
        now,
      ).get('a')?.lastUrl;
    expect(lastUrl('url: localhost:5173')).toBe('http://localhost:5173/');
    expect(lastUrl('url: localhost:5173/play?level=2 · element: x')).toBe('http://localhost:5173/play?level=2');
    expect(lastUrl('url: example.com')).toBe('http://example.com/');
    expect(lastUrl('url: https://example.com')).toBe('https://example.com/');
    expect(lastUrl('url: file:///etc/passwd')).toBeNull();
  });
});
