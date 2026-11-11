import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderStatic } from '../staticRender';
import { SshKeyMissingBanner } from './SecurityBanner';

describe('SshKeyMissingBanner', () => {
  it('is not there without projects', () => {
    expect(renderStatic(createElement(SshKeyMissingBanner, { projects: undefined }))).toBe('');
    expect(renderStatic(createElement(SshKeyMissingBanner, { projects: [] }))).toBe('');
  });

  it('names the project, links to its settings and to Settings → SSH key', () => {
    const html = renderStatic(
      createElement(SshKeyMissingBanner, { projects: [{ projectId: 'p1', name: 'Shop' }] }),
    );
    expect(html).toContain('href="/projects/p1/settings"');
    expect(html).toContain('>Shop</a> reaches its repository over ssh');
    expect(html).toContain('href="/settings?tab=ssh_key#ssh-key"');
    expect(html).toContain('Settings → SSH key');
  });

  it('names three projects and counts the rest', () => {
    const projects = ['A', 'B', 'C', 'D'].map((name) => ({ projectId: name.toLowerCase(), name }));
    const html = renderStatic(createElement(SshKeyMissingBanner, { projects }));
    expect(html).toContain('>C</a> and 1 more reach their repositories over ssh');
    expect(html).not.toContain('>D</a>');
  });
});
