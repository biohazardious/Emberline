import type { ForgeAccountsResponse, Project, RepositoryStatus } from '@emberline/protocol';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ForgeAccountsPanel } from './components/ForgeAccountsPanel';
import { RepositoryPanel } from './components/RepositoryPanel';
import { renderStatic } from './staticRender';

const project = { id: 'p1', slug: 'app' } as unknown as Project;
const status = {
  isGitRepo: true,
  branch: 'main',
  defaultBranch: 'main',
  hasCommits: true,
  originUrl: 'https://github.com/o/app.git',
  connected: true,
  mainState: 'ahead',
  ahead: 1,
  keepMainPushed: false,
  originHasCredentials: false,
} as unknown as RepositoryStatus;
const accounts = {
  accounts: [
    {
      id: 'a1',
      provider: 'github',
      serverUrl: 'https://github.com',
      username: 'me',
      source: 'user',
    },
  ],
  legacyTokenUnmatched: false,
} as unknown as ForgeAccountsResponse;

describe('static render', () => {
  it('renders the Repository block from cached answers', () => {
    const html = renderStatic(createElement(RepositoryPanel, { project }), {
      '/api/projects/p1/repository': status,
      '/api/forge/accounts': accounts,
    });
    expect(html).toContain('Push main to origin');
    // Both forms are there (only with the cached status) and start closed.
    expect(html.match(/<details class="repo-form">/g)).toHaveLength(2);
  });

  it('renders empty feedback regions before any result (A-10)', () => {
    const html = renderStatic(createElement(ForgeAccountsPanel), { '/api/forge/accounts': accounts });
    // Legacy token, the cached account and Add: one status and one alert region each.
    expect(html.match(/role="status"><\/p>/g)).toHaveLength(3);
    expect(html.match(/role="alert"><\/p>/g)).toHaveLength(3);
  });
});
