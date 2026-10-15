import { describe, expect, it } from 'vitest';
import { BROWSER_DAEMON_SCRIPT, isBrowsableUrl } from './factory/browser-daemon.js';

/** The daemon is a standalone script run in the runner; its URL guard is evaluated from the source. */
function loadNormalizeNavigateUrl(): (raw: string) => string {
  const match = /function normalizeNavigateUrl\(rawUrl\) \{[\s\S]*?\n\}/.exec(BROWSER_DAEMON_SCRIPT);
  if (!match) throw new Error('normalizeNavigateUrl not found in the daemon script');
  return new Function(`${match[0]}; return normalizeNavigateUrl;`)() as (raw: string) => string;
}

describe('browser daemon navigation (S17)', () => {
  const normalize = loadNormalizeNavigateUrl();

  it('opens web pages and bare hosts', () => {
    expect(normalize('')).toBe('about:blank');
    expect(normalize('about:blank')).toBe('about:blank');
    expect(normalize('https://example.com/a')).toBe('https://example.com/a');
    expect(normalize('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalize('example.com')).toBe('http://example.com/');
  });

  it('refuses file, javascript, data and browser-internal URLs', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings']) {
      expect(() => normalize(url)).toThrow(/only http\(s\) URLs/);
    }
  });

  it('core applies the same rule before forwarding an action', () => {
    for (const url of ['', 'about:blank', 'https://example.com', 'localhost:5173', 'example.com']) {
      expect(isBrowsableUrl(url)).toBe(true);
      expect(() => normalize(url)).not.toThrow();
    }
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings']) {
      expect(isBrowsableUrl(url)).toBe(false);
    }
  });
});
