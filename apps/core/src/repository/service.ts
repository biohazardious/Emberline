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
import { isRunnerUnavailable } from '../command-exec.js';
import { type RemoteCheck, readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { isEmberlineMergeCommit, withMainWorkspaceLock } from '../factory/merge.js';
import { accountForGitRemote, accountForRemote, gitCredentialForRemote } from '../forge/account-store.js';
import type { ForgeAccountsService } from '../forge/accounts.js';
import { parseForgeRemote } from '../forge/service.js';
import { describeGitError, type GitGateway } from '../git-gateway/gateway.js';
import { KeyedMutex } from '../keyed-mutex.js';
import {
  aheadBehind,
  branchTip,
  DIVERGED_MESSAGE,
  fetchBranchObjects,
  isAncestorCommit,
  listRemoteBranches,
  MAIN_MOVED_MESSAGE,
  mainBranchState,
  originUrls,
  pushBranch,
  type RemoteAccess,
  remoteBranchHead,
  remoteUrlForDisplay,
  setOrigin,
  setRemoteTracking,
  setUpstream,
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
/** A full commit id (SHA-1 or SHA-256), never an abbreviation. */
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const remoteErrorText = (error: unknown) =>
  error instanceof HttpError ? error.message : shortGitError(error);

/** What a refresh or push read under the main-workspace lock, for its network call outside it. */
interface Snapshot {
  path: string;
  branch: string;
  defaultBranch: string;
  access: RemoteAccess;
}

export class RepositoryService {
  /**
   * Refresh and push, one at a time per project. Their network calls run outside the
   * main-workspace lock, so a merge never waits on the forge.
   */
  private readonly remoteOps = new KeyedMutex();

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
      originHasCredentials: false,
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
    // A token someone put into origin by hand is never returned.
    const shown = remoteUrlForDisplay(origin);
    const transport = /^https:/i.test(origin) ? 'https' : /^http:/i.test(origin) ? 'http' : 'ssh';
    // ssh keeps the host rule; http(s) follows git's: the account whose server covers the URL.
    const account =
      transport === 'ssh' ? accountForRemote(this.db, origin) : accountForGitRemote(this.db, shown.url);
    const withOrigin: RepositoryStatus = {
      ...withRepo,
      originUrl: shown.url,
      originHasCredentials: shown.hadCredentials,
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
    await this.remoteOps.run(projectId, async () =>
      this.readRemote(projectId, await this.snapshot(projectId)),
    );
    return this.status(projectId);
  }

  /** The workspace and origin, read under the main-workspace lock (local only). */
  private async snapshot(projectId: string): Promise<Snapshot> {
    return withMainWorkspaceLock(this.project(projectId).path, async () => {
      const ws = await this.workspace(projectId);
      return { ...ws, access: await this.access(projectId, ws.path) };
    });
  }

  /** Under the lock: origin and projects.repoUrl still name what the network call used. */
  private async originStill(projectId: string, ws: Snapshot): Promise<boolean> {
    const { fetch, push } = await originUrls(ws.path);
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return row?.repoUrl === ws.access.url && fetch === ws.access.url && (!push || push === fetch);
  }

  async connect(projectId: string, raw: unknown): Promise<RepositoryStatus> {
    const body = parse(ConnectRepositoryBody, raw);
    const { url, host } = validateRepositoryUrl(body.url);
    const ws = await this.workspace(projectId);
    // Refused before the remote is contacted; checked again under the lock when origin is set.
    const { fetch: current } = await originUrls(ws.path);
    if (current && current !== url && !body.replace) throw this.originExists(current, url);
    const access = this.accessFor(projectId, url); // an unchecked account keeps its own error
    try {
      // Readable before anything changes; an empty repository answers with no branches.
      await listRemoteBranches(ws.path, access);
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
    const result = await this.push(projectId, { mergeOid: undefined });
    if (result === 'rejected') throw new HttpError(409, 'main_diverged', DIVERGED_MESSAGE);
    writeRepositorySettings(this.db, projectId, { lastMainPushError: null });
    return this.status(projectId);
  }

  /**
   * Keep main pushed after a merge: only the commit that merge made (`mergeOid`, its full id), and
   * only while the default branch still names it. A tip that is a later Emberline merge is left to
   * that merge's own push (no failure); any other tip is not Emberline's and is never published.
   */
  async pushMainQuietly(
    projectId: string,
    mergeOid: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string; runnerUnavailable?: true }> {
    let reason: string;
    try {
      const result = await this.push(projectId, { mergeOid });
      if (result === 'superseded') return { ok: true };
      if (result === 'pushed') {
        writeRepositorySettings(this.db, projectId, { lastMainPushError: null });
        return { ok: true };
      }
      reason = DIVERGED_MESSAGE;
    } catch (error) {
      // Nothing was decided: the push is tried again once the runner is back.
      if (isRunnerUnavailable(error)) return { ok: false, reason: remoteErrorText(error), runnerUnavailable: true };
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
   * Push one commit of the default branch, in three steps: under the main-workspace lock, the branch,
   * its commit and origin are read; with no lock, exactly that commit is pushed (whatever the ref
   * names by then); under the lock again, the tracking ref and the read of origin are recorded, if
   * origin is still the one pushed to. A rejected push reads origin again so status shows why.
   * `mergeOid` undefined: a person's Push main (the tip, with the default branch checked out);
   * otherwise Keep main pushed (the merge's commit, only while it is still the tip; `superseded`:
   * the tip is a later Emberline merge, whose own push publishes it).
   */
  private async push(
    projectId: string,
    { mergeOid }: { mergeOid: string | null | undefined },
  ): Promise<'pushed' | 'rejected' | 'superseded'> {
    return this.remoteOps.run(projectId, async () => {
      const plan = await withMainWorkspaceLock(this.project(projectId).path, async () => {
        const ws = await this.workspace(projectId);
        const tip = await branchTip(ws.path, ws.defaultBranch);
        if (mergeOid === undefined) {
          if (ws.branch !== ws.defaultBranch) {
            throw conflict(`The main workspace is on ${ws.branch}, not ${ws.defaultBranch}.`, 'branch_differs');
          }
          if (!tip) throw conflict('Main has no commits yet.', 'no_commits');
        } else {
          // A full id compared as is: a prefix is never resolved (an agent can plant a commit that matches it).
          const full = mergeOid !== null && FULL_OID.test(mergeOid) ? mergeOid : null;
          if (!full || !tip) throw conflict(MAIN_MOVED_MESSAGE, 'main_moved');
          if (tip.sha !== full) {
            // A later Emberline merge on top of this one: its own push publishes both. A rewind to an
            // older merge (this one not in the tip's history) is "moved".
            if (isEmberlineMergeCommit(ws.path, tip.sha) && (await isAncestorCommit(ws.path, full, tip.sha)))
              return 'superseded' as const;
            // The merge went into the branch checked out instead (it never was on the default branch).
            if (
              ws.branch !== ws.defaultBranch &&
              (await isAncestorCommit(ws.path, full, `refs/heads/${ws.branch}`)) &&
              !(await isAncestorCommit(ws.path, full, `refs/heads/${ws.defaultBranch}`))
            )
              throw conflict(
                `The merge went into ${ws.branch}, which is checked out in the main workspace; Keep main pushed pushes only ${ws.defaultBranch}.`,
                'merged_elsewhere',
              );
            throw conflict(MAIN_MOVED_MESSAGE, 'main_moved');
          }
        }
        return { ...ws, oid: tip.sha, access: await this.access(projectId, ws.path) };
      });
      if (plan === 'superseded') return plan;
      const result = await pushBranch(plan.path, plan.access, plan.defaultBranch, plan.oid);
      if (result === 'rejected') {
        await this.readRemote(projectId, plan);
        return result;
      }
      await withMainWorkspaceLock(plan.path, async () => {
        if (!(await this.originStill(projectId, plan))) return; // origin changed meanwhile: its own read counts
        await setRemoteTracking(plan.path, plan.defaultBranch, plan.oid);
        await setUpstream(plan.path, plan.defaultBranch);
        const check: RemoteCheck = {
          url: plan.access.url,
          branch: plan.defaultBranch,
          at: new Date().toISOString(),
          published: true,
          error: null,
        };
        try {
          writeRepositorySettings(this.db, projectId, { lastRemoteCheck: check });
        } catch {
          // the project was deleted meanwhile
        }
      });
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
        `origin (${remoteUrlForDisplay(fetch).url}) is not the repository connected for this project. Connect it under "Connect an existing repository" first.`,
        'origin_differs',
      );
    }
    return this.accessFor(projectId, fetch);
  }

  /**
   * ls-remote, then the branch's objects (no ref written), outside the main-workspace lock; then,
   * under it, refs/remotes/origin/<branch> set to the commit ls-remote reported and the read (or why
   * it failed) kept; a failed read is recorded, not thrown. Nothing is recorded when origin changed
   * meanwhile.
   */
  private async readRemote(projectId: string, ws: Snapshot): Promise<void> {
    const branch = ws.defaultBranch;
    const at = new Date().toISOString();
    let check: RemoteCheck;
    let remoteOid: string | null = null;
    try {
      remoteOid = await remoteBranchHead(ws.path, ws.access, branch);
      if (remoteOid) await fetchBranchObjects(ws.path, ws.access, branch, remoteOid);
      check = { url: ws.access.url, branch, at, published: remoteOid !== null, error: null };
    } catch (error) {
      if (isRunnerUnavailable(error)) throw error; // origin was not read: nothing to record
      remoteOid = null;
      const reason =
        error instanceof HttpError ? error.message : describeGitError(error, ws.access.account?.credential);
      check = { url: ws.access.url, branch, at, published: false, error: reason };
    }
    await withMainWorkspaceLock(ws.path, async () => {
      if (!(await this.originStill(projectId, ws))) return; // origin changed meanwhile: its own read counts
      if (remoteOid) {
        try {
          await setRemoteTracking(ws.path, branch, remoteOid);
        } catch (error) {
          if (isRunnerUnavailable(error)) throw error;
          check = { ...check, published: false, error: describeGitError(error, ws.access.account?.credential) };
        }
      }
      try {
        writeRepositorySettings(this.db, projectId, { lastRemoteCheck: check });
      } catch {
        // the project was deleted meanwhile
      }
    });
  }

  /** Names origin without user info, query or fragment: a token set by hand in it is never echoed. */
  private originExists(current: string, next?: string): HttpError {
    const shown = remoteUrlForDisplay(current);
    const credentialsOnly = next !== undefined && shown.hadCredentials && shown.url === next;
    const message = credentialsOnly
      ? `origin already points at ${shown.url}, with a user name or token in its URL. Replace it with the clean URL?`
      : `This project already has origin ${shown.url}. Replace it?`;
    return new HttpError(409, 'origin_exists', message, { origin: shown.url, credentialsOnly });
  }

  private async setOriginLocked(
    projectId: string,
    mainPath: string,
    url: string,
    replace: boolean,
  ): Promise<void> {
    await withMainWorkspaceLock(mainPath, async () => {
      const { fetch: current } = await originUrls(mainPath);
      if (current && current !== url && !replace) throw this.originExists(current, url);
      await setOrigin(mainPath, url, current);
      this.db.update(projects).set({ repoUrl: url }).where(eq(projects.id, projectId)).run();
    });
  }
}
