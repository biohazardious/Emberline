import type { RepositoryStatus } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import {
  accountText,
  connectPrefill,
  createRepoEnabled,
  existingOrigin,
  originCredentialsText,
  lastPushText,
  mainStateText,
  mainTipText,
  pushMainBlocked,
  replaceOriginQuestion,
  repoErrorForm,
} from './repository';

const base: RepositoryStatus = {
  isGitRepo: true,
  branch: 'main',
  defaultBranch: 'main',
  hasCommits: true,
  mainTip: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Add login' },
  originUrl: 'https://git.example.com/al/app.git',
  originHost: 'git.example.com',
  transport: 'https',
  account: { id: 'a1', provider: 'gitea', serverUrl: 'https://git.example.com', username: 'al' },
  connected: true,
  mainState: 'up_to_date',
  ahead: 0,
  behind: 0,
  remoteError: null,
  checkedAt: '2026-10-22T10:00:00.000Z',
  originHasCredentials: false,
  keepMainPushed: false,
  lastMainPushError: null,
};

describe('mainStateText', () => {
  it('words each state', () => {
    expect(mainStateText({ ...base, mainState: 'no_remote', originUrl: null })).toBe('No remote yet');
    expect(mainStateText({ ...base, mainState: 'unpublished' })).toBe('Not published yet');
    expect(mainStateText(base)).toBe('Up to date');
    expect(mainStateText({ ...base, mainState: 'ahead', ahead: 1 })).toBe('1 commit not pushed');
    expect(mainStateText({ ...base, mainState: 'ahead', ahead: 3 })).toBe('3 commits not pushed');
    expect(mainStateText({ ...base, mainState: 'behind', behind: 1, ahead: 0 })).toBe(
      "Remote has 1 commit main doesn't have",
    );
    expect(mainStateText({ ...base, mainState: 'diverged', behind: 2, ahead: 1 })).toBe(
      "Remote has 2 commits main doesn't have",
    );
    expect(mainStateText({ ...base, mainState: 'behind', behind: null })).toBe(
      "Remote has commits main doesn't have",
    );
    expect(mainStateText({ ...base, mainState: 'unknown', remoteError: 'Authentication failed' })).toBe(
      "Couldn't read origin: Authentication failed",
    );
    expect(mainStateText({ ...base, mainState: 'unknown', remoteError: null, checkedAt: null })).toBe(
      'Not checked yet',
    );
    expect(mainStateText({ ...base, isGitRepo: false })).toBe('This project folder is not a git repository.');
  });
});

describe('accountText', () => {
  it('names the account, or links to Settings', () => {
    expect(accountText(base)).toEqual({ text: 'Gitea / Forgejo account al', addAccount: false });
    expect(accountText({ ...base, account: null })).toEqual({
      text: 'No forge account for git.example.com',
      addAccount: true,
    });
    expect(accountText({ ...base, originUrl: null, originHost: null, account: null })).toBeNull();
    expect(accountText({ ...base, transport: 'ssh', account: null })).toEqual({
      text: "No forge account for git.example.com (SSH: pushes use the runner's own keys)",
      addAccount: true,
    });
  });
});

describe('pushMainBlocked and lastPushText', () => {
  it('says why Push main is off', () => {
    expect(pushMainBlocked({ ...base, mainState: 'ahead', ahead: 1 })).toBeNull();
    expect(pushMainBlocked({ ...base, mainState: 'unpublished' })).toBeNull();
    expect(pushMainBlocked(base)).toBe('Main is up to date.');
    expect(pushMainBlocked({ ...base, originUrl: null, mainState: 'no_remote' })).toBe(
      'Connect a repository first.',
    );
    expect(pushMainBlocked({ ...base, connected: false, mainState: 'unknown', checkedAt: null })).toBe(
      'Connect origin under "Connect an existing repository" first.',
    );
    expect(pushMainBlocked({ ...base, mainState: 'unknown', checkedAt: null })).toBeNull();
    expect(pushMainBlocked({ ...base, branch: null })).toBe('The main workspace is not on a branch.');
    expect(pushMainBlocked({ ...base, branch: 'dev', mainState: 'ahead', ahead: 1 })).toBe(
      'The main workspace is on dev, not main.',
    );
    expect(pushMainBlocked({ ...base, hasCommits: false, mainTip: null })).toBe('Main has no commits yet.');
    expect(pushMainBlocked({ ...base, isGitRepo: false })).toBe(
      'This project folder is not a git repository.',
    );
  });
  it('shows the last automatic failure', () => {
    expect(lastPushText(base)).toBeNull();
    expect(lastPushText({ ...base, lastMainPushError: 'Push failed: x' })).toBe(
      "Main isn't pushed: Push failed: x",
    );
  });
});

describe('mainTipText', () => {
  it('names the commit Push main would publish', () => {
    expect(mainTipText(base)).toBe('aaaaaaa Add login');
    expect(mainTipText({ ...base, mainTip: null })).toBeNull();
  });
});

describe('existingOrigin', () => {
  it('reads origin_exists', () => {
    expect(
      existingOrigin(new ApiRequestError(409, 'origin_exists', 'x', { origin: 'https://a/b.git' })),
    ).toBe('https://a/b.git');
    expect(existingOrigin(new ApiRequestError(409, 'conflict', 'x'))).toBeNull();
    expect(existingOrigin(new Error('x'))).toBeNull();
  });
});

describe('an origin with a user name or token in it', () => {
  it('says so, and Connect offers the clean URL core returned', () => {
    const withToken = { ...base, originHasCredentials: true };
    expect(originCredentialsText(withToken)).toBe(
      'The remote URL contains a user name or token. Connect the clean URL to use the forge account instead.',
    );
    expect(originCredentialsText(base)).toBeNull();
    expect(connectPrefill(withToken)).toBe('https://git.example.com/al/app.git');
    expect(connectPrefill({ ...withToken, connected: false })).toBe('https://git.example.com/al/app.git');
  });

  it('Connect offers an origin set outside Emberline, and nothing once it is connected and clean', () => {
    expect(connectPrefill({ ...base, connected: false })).toBe('https://git.example.com/al/app.git');
    expect(connectPrefill(base)).toBeNull();
    expect(connectPrefill({ ...base, originUrl: null, connected: false })).toBeNull();
  });
});

describe('replaceOriginQuestion', () => {
  it('uses the question core wrote', () => {
    expect(replaceOriginQuestion(new ApiRequestError(409, 'origin_exists', 'Q?', { origin: 'u' }))).toBe(
      'Q?',
    );
    expect(replaceOriginQuestion(new ApiRequestError(409, 'other', 'x'))).toBeNull();
    expect(replaceOriginQuestion(new Error('x'))).toBeNull();
  });
});

describe('createRepoEnabled', () => {
  it('needs owners that belong to the chosen account', () => {
    const base = { busy: false, accountId: 'b', owner: 'org-a', ownersAccountId: 'a', name: 'app' };
    expect(createRepoEnabled(base)).toBe(false);
    expect(createRepoEnabled({ ...base, owner: 'org-b', ownersAccountId: 'b' })).toBe(true);
    expect(createRepoEnabled({ ...base, owner: 'org-b', ownersAccountId: 'b', busy: true })).toBe(false);
    expect(createRepoEnabled({ ...base, owner: 'org-b', ownersAccountId: 'b', name: ' ' })).toBe(false);
  });
});

describe('repoErrorForm', () => {
  it('maps an action key to the form that shows its error', () => {
    expect(repoErrorForm('connect')).toBe('connect');
    expect(repoErrorForm('push')).toBe('actions');
    expect(repoErrorForm('create')).toBe('create');
  });
});
