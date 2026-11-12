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
  pushTarget: 'integration_branch',
  integrationBranch: 'emberline/integration',
  workingBranch: 'main',
  keepPushedBranch: 'emberline/integration',
  commitIdentity: null,
  factoryCommitIdentity: { name: 'Emberline AI Factory', email: 'factory@emberline.local' },
  originHasCredentials: false,
  originMasked: false,
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
    // Commit identity, Connect and Create are there (only with the cached status) and start closed.
    expect(html.match(/<details class="repo-form">/g)).toHaveLength(3);
    expect(html).toContain('Keep pushed pushes to');
    expect(html).toContain('Keep pushed pushes main to emberline/integration after each merge');
    expect(html).toContain('Push main to origin');
    expect(html).toContain('href="/projects/p1/git"');
    expect(html).toContain('Open the Git page');
  });

  it('follows the working branch: no push target, no Push main, a line pointing to the Git page', () => {
    const html = renderStatic(createElement(RepositoryPanel, { project }), {
      '/api/projects/p1/repository': { ...status, workingBranch: 'develop', keepPushedBranch: 'develop' },
      '/api/forge/accounts': accounts,
    });
    expect(html).toContain(
      'Pushes develop after each factory merge; main is pushed by Promote and Release on the Git page.',
    );
    // Said once, not a second time under the actions.
    expect(html.split('is pushed by Promote and Release').length).toBe(2);
    expect(html).not.toContain('Keep pushed pushes to');
    expect(html).not.toContain('An integration branch');
    expect(html).not.toContain('Push main to origin');
    expect(html).toContain('Keep pushed');
  });

  it('renders empty feedback regions before any result (A-10)', () => {
    const html = renderStatic(createElement(ForgeAccountsPanel), { '/api/forge/accounts': accounts });
    // Legacy token, the cached account and Add: one status and one alert region each.
    expect(html.match(/role="status"><\/p>/g)).toHaveLength(3);
    expect(html.match(/role="alert"><\/p>/g)).toHaveLength(3);
  });
});
