import type { RepositoryStatus } from '@emberline/protocol';
import { ApiRequestError } from './api';
import { PROVIDER_LABEL } from './forgeAccounts';

const NOT_GIT = 'This project folder is not a git repository.';
const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

export function mainStateText(s: RepositoryStatus): string {
  if (!s.isGitRepo) return NOT_GIT;
  switch (s.mainState) {
    case 'no_remote':
      return 'No remote yet';
    case 'unpublished':
      return 'Not published yet';
    case 'up_to_date':
      return 'Up to date';
    case 'ahead':
      return `${commits(s.ahead ?? 0)} not pushed`;
    case 'behind':
    case 'diverged':
      return s.behind
        ? `Remote has ${commits(s.behind)} main doesn't have`
        : "Remote has commits main doesn't have";
    default:
      if (s.remoteError) return `Couldn't read origin: ${s.remoteError}`;
      return s.checkedAt ? "Couldn't read origin" : 'Not checked yet';
  }
}

export function accountText(s: RepositoryStatus): { text: string; addAccount: boolean } | null {
  if (!s.originUrl) return null;
  const ssh = s.transport === 'ssh' ? " (SSH: pushes use the runner's own keys)" : '';
  if (!s.account)
    return { text: `No forge account for ${s.originHost ?? 'this host'}${ssh}`, addAccount: true };
  return {
    text: `${PROVIDER_LABEL[s.account.provider]} account ${s.account.username ?? s.originHost ?? ''}${ssh}`.trim(),
    addAccount: false,
  };
}

export function pushMainBlocked(s: RepositoryStatus): string | null {
  if (!s.isGitRepo) return NOT_GIT;
  if (!s.branch) return 'The main workspace is not on a branch.';
  if (s.branch !== s.defaultBranch) return `The main workspace is on ${s.branch}, not ${s.defaultBranch}.`;
  if (!s.hasCommits) return 'Main has no commits yet.';
  if (!s.originUrl) return 'Connect a repository first.';
  if (!s.connected) return 'Connect origin under "Connect an existing repository" first.';
  if (s.mainState === 'up_to_date') return 'Main is up to date.';
  return null;
}

/** The commit Push main would publish: short id and subject. */
export function mainTipText(s: RepositoryStatus): string | null {
  return s.mainTip ? `${s.mainTip.shortSha} ${s.mainTip.subject}` : null;
}

export function lastPushText(s: RepositoryStatus): string | null {
  return s.lastMainPushError ? `Main isn't pushed: ${s.lastMainPushError}` : null;
}

/** origin_exists from connect/create: the origin to name in the confirm, else null. */
export function existingOrigin(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'origin_exists') return null;
  return typeof error.data.origin === 'string' ? error.data.origin : null;
}

/** origin as configured holds a user name or token (core returns it without them). */
export function originCredentialsText(s: RepositoryStatus): string | null {
  return s.originHasCredentials
    ? 'The remote URL contains a user name or token. Connect the clean URL to use the forge account instead.'
    : null;
}

/** What Connect offers: an origin set outside Emberline, or the clean URL of one holding a token. */
export function connectPrefill(s: RepositoryStatus): string | null {
  if (!s.originUrl) return null;
  return !s.connected || s.originHasCredentials ? s.originUrl : null;
}

/** origin_exists from connect/create: core's own question (it names the clean URL), else null. */
export function replaceOriginQuestion(error: unknown): string | null {
  return error instanceof ApiRequestError && error.code === 'origin_exists' ? error.message : null;
}

/** Create needs owners fetched for the chosen account, one of them chosen, and a name. */
export function createRepoEnabled(v: {
  busy: boolean;
  accountId: string;
  owner: string;
  ownersAccountId: string | null;
  name: string;
}): boolean {
  return !v.busy && Boolean(v.accountId) && v.ownersAccountId === v.accountId && Boolean(v.owner) && Boolean(v.name.trim());
}

/** The form that shows the error of an action key. */
export function repoErrorForm(key: string): 'connect' | 'create' | 'actions' {
  return key === 'connect' ? 'connect' : key === 'create' ? 'create' : 'actions';
}
