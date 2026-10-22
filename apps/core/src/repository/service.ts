import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  ConnectRepositoryBody,
  CreateRepositoryBody,
  type RepositoryStatus,
  UpdateRepositoryBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { type RemoteCheck, readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { withMainWorkspaceLock } from '../factory/merge.js';
import { accountForRemote, gitCredentialForRemote } from '../forge/account-store.js';
import type { ForgeAccountsService } from '../forge/accounts.js';
import { parseForgeRemote } from '../forge/service.js';
import { describeGitError, type GitGateway } from '../git-gateway/gateway.js';
import {
  aheadBehind,
  branchTip,
  DIVERGED_MESSAGE,
  fetchBranch,
  listRemoteBranches,
  MAIN_MOVED_MESSAGE,
  mainBranchState,
  originUrls,
  pushBranch,
  type RemoteAccess,
  resolveCommit,
  setOrigin,
  shortGitError,
  validateRepositoryUrl,
} from './git.js';

const isGitRepo = (dir: string) =>
  lstat(path.join(dir, '.git')).then(
    () => true,
    () => false,
  );
const parse = <T>(
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
  },
  raw: unknown,
): T => {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw badRequest(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
};
const remoteErrorText = (error: unknown) =>
  error instanceof HttpError ? error.message : shortGitError(error);

export class RepositoryService {
  constructor(
    private readonly db: Db,
    private readonly accounts: ForgeAccountsService,
    private readonly gateway: GitGateway,
  ) {}

  private project(projectId: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw notFound('no such project');
    return row;
  }

  /**
   * A main workspace the repository actions may change: a git repository on a branch. `branch` is
   * what is checked out; `defaultBranch` (projects.defaultBranch) is what is read and pushed.
   */
  private async workspace(
    projectId: string,
  ): Promise<{ path: string; branch: string; defaultBranch: string }> {
    const row = this.project(projectId);
    if (!(await isGitRepo(row.path)))
      throw conflict('The project folder is not a git repository.', 'not_git_repo');
    const { branch } = await mainBranchState(row.path);
    if (!branch) throw conflict('The main workspace is not on a branch (detached HEAD).', 'detached_head');
    return { path: row.path, branch, defaultBranch: row.defaultBranch };
  }

  /**
   * Local only (no network): origin from the main workspace, the default branch's tip, and that
   * branch against refs/remotes/origin/<default> as the last read of origin left it.
   */
  async status(projectId: string): Promise<RepositoryStatus> {
    const row = this.project(projectId);
    const settings = readRepositorySettings(this.db, projectId);
    const base: RepositoryStatus = {
      isGitRepo: false,
      branch: null,
      defaultBranch: row.defaultBranch,
      hasCommits: false,
      mainTip: null,
      originUrl: null,
      originHost: null,
      transport: null,
      account: null,
      connected: false,
      mainState: 'no_remote',
      ahead: null,
      behind: null,
      remoteError: null,
      checkedAt: null,
      keepMainPushed: settings.keepMainPushed,
      lastMainPushError: settings.lastMainPushError,
    };
    if (!(await isGitRepo(row.path))) return base;
    const { branch } = await mainBranchState(row.path);
    const main = row.defaultBranch;
    const mainTip = await branchTip(row.path, main);
    const hasCommits = mainTip !== null;
    const { fetch: origin } = await originUrls(row.path);
    const withRepo: RepositoryStatus = { ...base, isGitRepo: true, branch, hasCommits, mainTip };
    if (!origin) return withRepo;
    const account = accountForRemote(this.db, origin);
    const transport = /^https:/i.test(origin) ? 'https' : /^http:/i.test(origin) ? 'http' : 'ssh';
    const withOrigin: RepositoryStatus = {
      ...withRepo,
      originUrl: origin,
      originHost: parseForgeRemote(origin)?.host ?? null,
      transport,
      account: account
        ? {
            id: account.id,
            provider: account.provider,
            serverUrl: account.serverUrl,
            username: account.username,
          }
        : null,
      connected: row.repoUrl === origin,
      mainState: 'unknown',
    };
    const check = settings.lastRemoteCheck;
    if (!check || check.url !== origin || check.branch !== main) return withOrigin; // not read since origin was set
    const checked: RepositoryStatus = { ...withOrigin, checkedAt: check.at };
    if (check.error) return { ...checked, remoteError: check.error };
    if (!check.published) return { ...checked, mainState: 'unpublished' };
    if (!hasCommits) return { ...checked, mainState: 'behind', ahead: 0, behind: null };
    try {
      const { ahead, behind } = await aheadBehind(row.path, main);
      const mainState = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'up_to_date';
      return { ...checked, mainState, ahead, behind };
    } catch {
      return withOrigin; // refs/remotes/origin/<branch> went away since: Refresh reads it again
    }
  }

  async refresh(projectId: string): Promise<RepositoryStatus> {
    const ws = await this.workspace(projectId);
    await withMainWorkspaceLock(ws.path, async () =>
      this.readRemote(projectId, ws.path, ws.defaultBranch, await this.access(projectId, ws.path)),
    );
    return this.status(projectId);
  }

  async connect(projectId: string, raw: unknown): Promise<RepositoryStatus> {
    const body = parse(ConnectRepositoryBody, raw);
    const { url, host } = validateRepositoryUrl(body.url);
    const ws = await this.workspace(projectId);
    try {
      // Readable before anything changes; an empty repository answers with no branches.
      await listRemoteBranches(ws.path, this.accessFor(projectId, url));
    } catch (error) {
      throw new HttpError(
        409,
        'remote_unreachable',
        `Couldn't read the repository on ${host}: ${remoteErrorText(error)}`,
      );
    }
    await this.setOriginLocked(projectId, ws.path, url, body.replace);
    return this.refresh(projectId);
  }

  async create(projectId: string, raw: unknown): Promise<RepositoryStatus> {
    const body = parse(CreateRepositoryBody, raw);
    const ws = await this.workspace(projectId);
    let account = this.accounts.record(body.accountId);
    // The user's own login decides between the user's and an organisation's endpoint.
    if (!account.username) {
      await this.accounts.check(account.id);
      account = this.accounts.record(account.id);
    }
    const { fetch: current } = await originUrls(ws.path);
    // Checked before the forge is called, and again under the lock when origin is set.
    if (current && !body.replace) throw this.originExists(current);
    const { fullPath } = await this.accounts.createRepository(account, body);
    await this.setOriginLocked(projectId, ws.path, `${account.serverUrl}/${fullPath}.git`, body.replace);
    return this.refresh(projectId);
  }

  /** A person's click: the tip of the default branch, which must be the branch checked out. */
  async pushMain(projectId: string): Promise<RepositoryStatus> {
    const result = await this.push(projectId, { mergeSha: undefined });
    if (result === 'rejected') throw new HttpError(409, 'main_diverged', DIVERGED_MESSAGE);
    writeRepositorySettings(this.db, projectId, { lastMainPushError: null });
    return this.status(projectId);
  }

  /**
   * Keep main pushed after a merge: only the commit that merge made (`mergeSha`, the note's short
   * sha), and only while the default branch still names it; anything else is not Emberline's.
   */
  async pushMainQuietly(
    projectId: string,
    mergeSha: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    let reason: string;
    try {
      if ((await this.push(projectId, { mergeSha })) === 'pushed') {
        writeRepositorySettings(this.db, projectId, { lastMainPushError: null });
        return { ok: true };
      }
      reason = DIVERGED_MESSAGE;
    } catch (error) {
      reason = remoteErrorText(error);
    }
    try {
      writeRepositorySettings(this.db, projectId, { lastMainPushError: reason });
    } catch {
      // the project was deleted meanwhile
    }
    return { ok: false, reason };
  }

  update(projectId: string, raw: unknown): Promise<RepositoryStatus> {
    this.project(projectId);
    const body = parse(UpdateRepositoryBody, raw);
    writeRepositorySettings(this.db, projectId, { keepMainPushed: body.keepMainPushed });
    return this.status(projectId);
  }

  /**
   * Push one commit of the default branch, then read origin again (inside the same lock) so status
   * shows the result without a network call. The branch and its commit are read under the lock, and
   * exactly that commit is pushed, whatever the ref names by the time git runs.
   * `mergeSha` undefined: a person's Push main (the tip, with the default branch checked out);
   * otherwise Keep main pushed (the merge's commit, only while it is still the tip).
   */
  private async push(
    projectId: string,
    { mergeSha }: { mergeSha: string | null | undefined },
  ): Promise<'pushed' | 'rejected'> {
    return withMainWorkspaceLock(this.project(projectId).path, async () => {
      const ws = await this.workspace(projectId);
      const tip = await branchTip(ws.path, ws.defaultBranch);
      if (mergeSha === undefined) {
        if (ws.branch !== ws.defaultBranch) {
          throw conflict(`The main workspace is on ${ws.branch}, not ${ws.defaultBranch}.`, 'branch_differs');
        }
        if (!tip) throw conflict('Main has no commits yet.', 'no_commits');
      } else {
        const merge = mergeSha ? await resolveCommit(ws.path, mergeSha) : null;
        if (!merge || tip?.sha !== merge) throw conflict(MAIN_MOVED_MESSAGE, 'main_moved');
      }
      const access = await this.access(projectId, ws.path);
      const result = await pushBranch(ws.path, access, ws.defaultBranch, tip!.sha);
      await this.readRemote(projectId, ws.path, ws.defaultBranch, access);
      return result;
    });
  }

  private accessFor(projectId: string, url: string): RemoteAccess {
    const credential = gitCredentialForRemote(this.db, url);
    return { url, account: credential ? { gateway: this.gateway, projectId, url, credential } : null };
  }

  /** origin as Emberline connected it: refresh and push go to projects.repoUrl, never to a URL only .git/config names. */
  private async access(projectId: string, mainPath: string): Promise<RemoteAccess> {
    const { fetch, push } = await originUrls(mainPath);
    if (!fetch) throw conflict('Connect a repository first.', 'no_remote');
    if (push && push !== fetch) {
      throw conflict(
        'origin has a separate push URL. Emberline pushes only where it reads from; remove remote.origin.pushurl.',
        'push_url_differs',
      );
    }
    if (this.project(projectId).repoUrl !== fetch) {
      throw conflict(
        `origin (${fetch}) is not the repository connected for this project. Connect it under "Connect an existing repository" first.`,
        'origin_differs',
      );
    }
    return this.accessFor(projectId, fetch);
  }

  /** ls-remote, then the fetch of the branch when the remote has it; never throws, the result (or why it failed) is kept. */
  private async readRemote(
    projectId: string,
    mainPath: string,
    branch: string,
    access: RemoteAccess,
  ): Promise<void> {
    const at = new Date().toISOString();
    let check: RemoteCheck;
    try {
      const published = (await listRemoteBranches(mainPath, access, branch)).includes(branch);
      if (published) await fetchBranch(mainPath, access, branch);
      check = { url: access.url, branch, at, published, error: null };
    } catch (error) {
      const reason =
        error instanceof HttpError ? error.message : describeGitError(error, access.account?.credential);
      check = { url: access.url, branch, at, published: false, error: reason };
    }
    try {
      writeRepositorySettings(this.db, projectId, { lastRemoteCheck: check });
    } catch {
      // the project was deleted meanwhile
    }
  }

  private originExists(current: string): HttpError {
    return new HttpError(409, 'origin_exists', `This project already has origin ${current}. Replace it?`, {
      origin: current,
    });
  }

  private async setOriginLocked(
    projectId: string,
    mainPath: string,
    url: string,
    replace: boolean,
  ): Promise<void> {
    await withMainWorkspaceLock(mainPath, async () => {
      const { fetch: current } = await originUrls(mainPath);
      if (current && current !== url && !replace) throw this.originExists(current);
      await setOrigin(mainPath, url, current);
      this.db.update(projects).set({ repoUrl: url }).where(eq(projects.id, projectId)).run();
    });
  }
}
