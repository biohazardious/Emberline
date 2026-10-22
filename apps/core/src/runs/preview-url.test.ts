import { describe, expect, it } from 'vitest';
import { previewUrl } from './preview-url.js';

describe('previewUrl with EMBERLINE_PREVIEW_HOST', () => {
  it('replaces the port of the override, whatever it carries', () => {
    expect(previewUrl(4330, 'x', 'http://previews.lan:8080')).toBe('http://previews.lan:4330');
  });

  it('keeps an IPv6 literal bracketed', () => {
    expect(previewUrl(4330, 'x', 'http://[fd00::1]/')).toBe('http://[fd00::1]:4330');
  });

  it('falls back to the request host when the override has no scheme', () => {
    expect(previewUrl(4330, 'x', 'previews.lan')).toBe('http://x:4330');
  });

  it('keeps https and drops the trailing slash', () => {
    expect(previewUrl(4330, 'x', 'https://previews.example.net/')).toBe('https://previews.example.net:4330');
  });
});
