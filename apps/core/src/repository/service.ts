import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  ConnectRepositoryBody,
  CreateRepositoryBody,
  DEFAULT_INTEGRATION_BRANCH,
  type RepositoryStatus,
  UpdateRepositoryBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { isRunnerTimeout, isRunnerUnavailable } from '../command-exec.js';
import {
  effectivePushTarget,
  type RemoteCheck,
  type RepositorySettings,
  readRepositorySettings,
  workingBranchOf,
  writeRepositorySettings,
} from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { isEmberlineMergeCommit, withMainWorkspaceLock } from '../factory/merge.js';
import { getCommitIdentity } from '../factory/settings.js';
import { accountForGitRemote, accountForRemote } from '../forge/account-store.js';
import type { ForgeAccountsService } from '../forge/accounts.js';
import { remoteCompareKey } from '../forge/hosts.js';
import { secretDigest } from '../secrets/box.js';
import { parseForgeRemote } from '../forge/service.js';
import { describeGitError, type GitGateway, type KnownSecrets } from '../git-gateway/gateway.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { gatewayRemoteFor } from '../ssh-keys/remote.js';
import {
  accessSecrets,
  aheadBehind,
  branchTip,
  DIVERGED_MESSAGE,
  integrationDivergedMessage,
  isAncestorCommit,
  listOriginRefs,
  listRemoteBranches,
  MAIN_MOVED_MESSAGE,
  mainBranchState,
  originUrls,
  type OriginRefs,
  pushBranch,
  type RemoteAccess,
  remoteUrlForDisplay,
  RUNNER_WAITING_MESSAGE,
  setOrigin,
  setRemoteTracking,
  setUpstream,
  shortGitError,
  sshSetupError,
  validateRepositoryUrl,
  workingDivergedMessage,
  workingMovedMessage,
} from './git.js';
import { bringOriginObjects, type OriginObjects, writeOriginRefs } from './origin-refs.js';

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
export const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const remoteErrorText = (error: unknown, known?: KnownSecrets) =>
  error instanceof HttpError ? error.message : shortGitError(error, known);
/**
 * One repository: a user name or token typed into a URL is never part of which repository it names,
 * and neither is the case of its host.
 */
const sameRepository = (a: string | null, b: string) =>
  a !== null && remoteCompareKey(remoteUrlForDisplay(a).url) === remoteCompareKey(remoteUrlForDisplay(b).url);

/** The key a read of `origin` (as configured) is kept under. */
const originKey = (origin: string) => secretDigest('origin', origin);
/**
 * Whether the last read was of this origin: by its key, or for a read 0.6.0 or earlier recorded
 * (no key), by the address it kept (remoteUrlForDisplay's `url`).
 */
const readOf = (check: RemoteCheck, origin: string, url: string) =>
  check.originKey !== undefined ? check.originKey === originKey(origin) : check.url === url;

/** The remote branch Keep main pushed pushes main to: the default branch, or the integration branch. */
function keepPushedBranch(settings: RepositorySettings, defaultBranch: string): string {
  return effectivePushTarget(settings) === 'integration_branch'
    ? (settings.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH)
    : defaultBranch;
}

/**
 * Where Keep pushed publishes the factory's merges: the working branch when one other than the
 * default branch is stored (its own name on origin), else the 0.8.0 target above.
 */
export function keepPushedTarget(settings: RepositorySettings, defaultBranch: string): string {
  const working = workingBranchOf(settings, defaultBranch);
  return working !== defaultBranch ? working : keepPushedBranch(settings, defaultBranch);
}

/** What a refresh or push read under the main-workspace lock, for its network call outside it. */
export interface Snapshot {
  path: string;
  branch: string;
  defaultBranch: string;
  access: RemoteAccess;
  /** origin's URL as read under the lock (it may hold a token typed into it). */
  origin: string;
}

/** What a read of origin found: the commits its default and working branches name, as fetched. */
export interface OriginRead {
  /** null: origin has no such branch, or the read failed. */
  main: string | null;
  working: string | null;
  /** The working branch the read was of (the default branch when no other is set). */
  workingBranch: string;
  /** Why the read failed (it is recorded as the last read of origin), else null. */
  error: string | null;
  /** origin changed while it was read: nothing was recorded. */
  stale: boolean;
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
      originMasked: false,
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
      pushTarget: effectivePushTarget(settings),
      integrationBranch: settings.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH,
      workingBranch: workingBranchOf(settings, row.defaultBranch),
      keepPushedBranch: keepPushedTarget(settings, row.defaultBranch),
      lastMainPushError: settings.lastMainPushError,
      commitIdentity: settings.commitIdentity,
      factoryCommitIdentity: getCommitIdentity(this.db),
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
      originUrl: shown.display,
      originHasCredentials: shown.hadCredentials,
      originMasked: shown.display !== shown.url,
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
      connected: sameRepository(row.repoUrl, origin),
      mainState: 'unknown',
    };
    const check = settings.lastRemoteCheck;
    if (!check || !readOf(check, origin, shown.url) || check.branch !== main) return withOrigin; // not read since origin was set
    // Two addresses masked alike (`user:***@host:…`) are told apart by the connected repository:
    // refresh and push read only that one, so a read of another origin is never taken for it.
    if (withOrigin.originMasked && !withOrigin.connected) return withOrigin;
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
      this.readOrigin(projectId, await this.snapshot(projectId)),
    );
    return this.status(projectId);
  }

  /**
   * For the Git page's remote actions: `fn` runs in this project's remote-ops order (one refresh,
   * push or such action at a time), with the workspace and origin's access read under the
   * main-workspace lock. `fn` makes its network call with no lock and takes the lock again itself
   * for any local change.
   */
  async remoteAction<T>(projectId: string, fn: (ws: Snapshot) => Promise<T>): Promise<T> {
    return this.remoteOps.run(projectId, async () => fn(await this.snapshot(projectId)));
  }

  /** The workspace and origin, read under the main-workspace lock (local only). */
  private async snapshot(projectId: string): Promise<Snapshot> {
    return withMainWorkspaceLock(this.project(projectId).path, async () => {
      const ws = await this.workspace(projectId);
      return { ...ws, ...(await this.access(projectId, ws.path)) };
    });
  }

  /** Under the lock: origin and projects.repoUrl still name what the network call used. */
  async originStill(projectId: string, ws: Snapshot): Promise<boolean> {
    const { fetch, push } = await originUrls(ws.path);
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return (
      row !== undefined &&
      sameRepository(row.repoUrl, ws.origin) &&
      fetch === ws.origin &&
      (!push || push === fetch)
    );
  }

  async connect(projectId: string, raw: unknown): Promise<RepositoryStatus> {
    const body = parse(ConnectRepositoryBody, raw);
    const { url, host } = validateRepositoryUrl(body.url);
    const ws = await this.workspace(projectId);
    // Refused before the remote is contacted; checked again under the lock when origin is set.
    const { fetch: current } = await originUrls(ws.path);
    if (current && current !== url && !body.replace) throw this.originExists(current, url);
    // An unchecked account keeps its own error; an ssh address without its key fails here, before
    // anything runs.
    const access = this.accessFor(projectId, url);
    const known = accessSecrets(access);
    try {
      // Readable before anything changes; an empty repository answers with no branches.
      await listRemoteBranches(ws.path, access);
    } catch (error) {
      const prefix = `Couldn't read the repository on ${host}: `;
      throw (
        sshSetupError(error, prefix) ??
        new HttpError(409, 'remote_unreachable', `${prefix}${remoteErrorText(error, known)}`)
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
    if (result.outcome === 'rejected') throw new HttpError(409, 'main_diverged', DIVERGED_MESSAGE);
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
  ): Promise<{ ok: true } | { ok: false; reason: string; runnerUnavailable?: 'timeout' | 'away' }> {
    let reason: string;
    try {
      const result = await this.push(projectId, { mergeOid });
      if (result.outcome === 'superseded') return { ok: true };
      if (result.outcome === 'pushed') {
        writeRepositorySettings(this.db, projectId, { lastMainPushError: null });
        return { ok: true };
      }
      reason = result.onWorking
        ? workingDivergedMessage(result.branch)
        : result.branch === result.defaultBranch
          ? DIVERGED_MESSAGE
          : integrationDivergedMessage(result.branch);
    } catch (error) {
      // Nothing was decided: the push is tried again once the runner is back.
      if (isRunnerUnavailable(error))
        return {
          ok: false,
          reason: remoteErrorText(error),
          runnerUnavailable: isRunnerTimeout(error) ? 'timeout' : 'away',
        };
      reason = remoteErrorText(error);
    }
    try {
      writeRepositorySettings(this.db, projectId, { lastMainPushError: reason });
    } catch {
      // the project was deleted meanwhile
    }
    return { ok: false, reason };
  }

  async update(projectId: string, raw: unknown): Promise<RepositoryStatus> {
    const row = this.project(projectId);
    const body = parse(UpdateRepositoryBody, raw);
    const current = readRepositorySettings(this.db, projectId);
    const keepMainPushed = body.keepMainPushed ?? current.keepMainPushed;
    // Stored once chosen: a project that pushed its default branch before keeps doing so, one that
    // opts in now pushes the integration branch, whatever is switched later.
    const pushTarget = body.pushTarget ?? effectivePushTarget(current);
    const integrationBranch = body.integrationBranch ?? current.integrationBranch;
    if (integrationBranch !== undefined && integrationBranch === row.defaultBranch) {
      throw badRequest(
        `The integration branch must not be ${row.defaultBranch}, the default branch; choose "the default branch" to push it.`,
      );
    }
    const next = { ...current, pushTarget, integrationBranch };
    const branchChanged =
      keepPushedTarget(next, row.defaultBranch) !== keepPushedTarget(current, row.defaultBranch);
    // Switched off, a push kept for the runner never runs: it no longer waits. A failure of a push
    // to another branch says nothing about the new one.
    const stale = branchChanged || (!keepMainPushed && current.lastMainPushError === RUNNER_WAITING_MESSAGE);
    writeRepositorySettings(this.db, projectId, {
      keepMainPushed,
      pushTarget,
      ...(integrationBranch !== undefined ? { integrationBranch } : {}),
      ...(body.commitIdentity !== undefined ? { commitIdentity: body.commitIdentity } : {}),
      ...(stale ? { lastMainPushError: null } : {}),
    });
    return this.status(projectId);
  }

  /**
   * Push one commit of the default branch, in three steps: under the main-workspace lock, the branch,
   * its commit and origin are read; with no lock, exactly that commit is pushed (whatever the ref
   * names by then); under the lock again, the tracking ref and the read of origin are recorded, if
   * origin is still the one pushed to. A rejected push reads origin again so status shows why.
   * `mergeOid` undefined: a person's Push main (the tip, with the default branch checked out, to the
   * default branch); otherwise Keep main pushed (the merge's commit, only while it is still the tip;
   * `superseded`: the tip is a later Emberline merge, whose own push publishes it), to the branch its
   * push target names. An integration branch is Emberline's own: it is fast-forwarded like main and
   * never forced, and a push someone made to it rejects Emberline's like a remote main that moved on.
   * With a working branch other than the default branch, checked out, Keep pushed reads and pushes
   * that branch instead, to its own name (`onWorking`), by the same rules; the push target does not
   * apply. `branch` is the remote branch it went to.
   */
  private async push(
    projectId: string,
    { mergeOid }: { mergeOid: string | null | undefined },
  ): Promise<{
    outcome: 'pushed' | 'rejected' | 'superseded';
    branch: string;
    defaultBranch: string;
    onWorking: boolean;
  }> {
    return this.remoteOps.run(projectId, async () => {
      const plan = await withMainWorkspaceLock(this.project(projectId).path, async () => {
        const ws = await this.workspace(projectId);
        const settings = readRepositorySettings(this.db, projectId);
        const working = workingBranchOf(settings, ws.defaultBranch);
        // Keep pushed with a working branch of its own, checked out: the factory merges into it, so
        // it is what is pushed, to its own name on origin. Main is pushed by Promote and Release.
        const onWorking = mergeOid !== undefined && working !== ws.defaultBranch && ws.branch === working;
        const local = onWorking ? working : ws.defaultBranch;
        const tip = await branchTip(ws.path, local);
        const branch =
          mergeOid === undefined
            ? ws.defaultBranch
            : onWorking
              ? working
              : keepPushedBranch(settings, ws.defaultBranch);
        const movedMessage = onWorking ? workingMovedMessage(working) : MAIN_MOVED_MESSAGE;
        if (mergeOid === undefined) {
          if (ws.branch !== ws.defaultBranch) {
            throw conflict(
              `The main workspace is on ${ws.branch}, not ${ws.defaultBranch}.`,
              'branch_differs',
            );
          }
          if (!tip) throw conflict('Main has no commits yet.', 'no_commits');
        } else {
          // A full id compared as is: a prefix is never resolved (an agent can plant a commit that matches it).
          const full = mergeOid !== null && FULL_OID.test(mergeOid) ? mergeOid : null;
          if (!full || !tip) throw conflict(movedMessage, 'main_moved');
          if (tip.sha !== full) {
            // A later Emberline merge on top of this one: its own push publishes both. A rewind to an
            // older merge (this one not in the tip's history) is "moved".
            if (isEmberlineMergeCommit(ws.path, tip.sha) && (await isAncestorCommit(ws.path, full, tip.sha)))
              return { superseded: true as const, branch, defaultBranch: ws.defaultBranch, onWorking };
            // The merge went into the branch checked out instead (it never was on the default branch).
            if (
              !onWorking &&
              ws.branch !== ws.defaultBranch &&
              (await isAncestorCommit(ws.path, full, `refs/heads/${ws.branch}`)) &&
              !(await isAncestorCommit(ws.path, full, `refs/heads/${ws.defaultBranch}`))
            )
              throw conflict(
                working === ws.defaultBranch
                  ? `The merge went into ${ws.branch}, which is checked out in the main workspace; Keep main pushed pushes only ${ws.defaultBranch}.`
                  : `The merge went into ${ws.branch}, which is checked out in the main workspace; Keep pushed pushes only ${working}, the working branch.`,
                'merged_elsewhere',
              );
            throw conflict(movedMessage, 'main_moved');
          }
        }
        return {
          superseded: false as const,
          onWorking,
          ...ws,
          branch,
          oid: tip.sha,
          ...(await this.access(projectId, ws.path)),
        };
      });
      const { branch, defaultBranch, onWorking } = plan;
      if (plan.superseded) return { outcome: 'superseded', branch, defaultBranch, onWorking };
      const result = await pushBranch(plan.path, plan.access, branch, plan.oid);
      if (result === 'rejected') {
        // Only the default branch's read shows in status (main against origin's main).
        if (branch === defaultBranch) await this.readOrigin(projectId, plan);
        return { outcome: result, branch, defaultBranch, onWorking };
      }
      await this.recordPush(projectId, plan, branch, plan.oid);
      return { outcome: result, branch, defaultBranch, onWorking };
    });
  }

  /**
   * After a push of `oid` to origin's `branch` (with `ws` as read for it): under the main-workspace
   * lock, the tracking ref, and for the default branch its upstream and the read of origin's main,
   * if origin is still the one pushed to.
   */
  async recordPush(projectId: string, ws: Snapshot, branch: string, oid: string): Promise<void> {
    await withMainWorkspaceLock(ws.path, async () => {
      if (!(await this.originStill(projectId, ws))) return; // origin changed meanwhile: its own read counts
      await setRemoteTracking(ws.path, branch, oid);
      // main's upstream and the read of origin's main are the default branch's alone.
      if (branch !== ws.defaultBranch) return;
      await setUpstream(ws.path, ws.defaultBranch);
      const check: RemoteCheck = {
        url: remoteUrlForDisplay(ws.origin).display,
        originKey: originKey(ws.origin),
        branch: ws.defaultBranch,
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
  }

  /** Through the gateway with the account or the chosen SSH key, or direct; a missing key throws `ssh_key_missing`. */
  private accessFor(projectId: string, url: string): RemoteAccess {
    return { url, remote: gatewayRemoteFor(this.db, this.gateway, this.project(projectId), url) };
  }

  /**
   * origin as Emberline connected it: refresh and push go to the repository projects.repoUrl names,
   * never to one only .git/config names. A token typed into origin does not make it another
   * repository: without an account git reaches origin as configured (with that token); an account
   * only ever goes to projects.repoUrl, through the gateway.
   */
  private async access(
    projectId: string,
    mainPath: string,
  ): Promise<{ access: RemoteAccess; origin: string }> {
    const { fetch, push } = await originUrls(mainPath);
    if (!fetch) throw conflict('Connect a repository first.', 'no_remote');
    if (push && push !== fetch) {
      throw conflict(
        'origin has a separate push URL. Emberline pushes only where it reads from; remove remote.origin.pushurl.',
        'push_url_differs',
      );
    }
    const connected = this.project(projectId).repoUrl;
    if (connected === null || !sameRepository(connected, fetch)) {
      throw conflict(
        `origin (${remoteUrlForDisplay(fetch).display}) is not the repository connected for this project. Connect it under "Connect an existing repository" first.`,
        'origin_differs',
      );
    }
    const access = this.accessFor(projectId, connected);
    return { access: access.remote ? access : { url: fetch, remote: null }, origin: fetch };
  }

  /**
   * All of origin in one ls-remote (every branch and tag), then the objects that are missing in one
   * fetch (no ref written), outside the main-workspace lock; then, under it, each
   * refs/remotes/origin/<branch> set to the commit ls-remote reported, those of branches origin no
   * longer has removed, origin's tags this project lacks created (a local tag is never moved: one
   * that differs from origin's is kept, and listed for the Git page), and the read of the default
   * branch (or why it failed) kept. A failed read is recorded and returned, not thrown. Nothing is
   * recorded when origin changed meanwhile (`stale`).
   */
  async readOrigin(projectId: string, ws: Snapshot): Promise<OriginRead> {
    const branch = ws.defaultBranch;
    const workingBranch = workingBranchOf(readRepositorySettings(this.db, projectId), branch);
    const separate = workingBranch !== branch;
    const needed = separate ? [branch, workingBranch] : [branch];
    const at = new Date().toISOString();
    const checkedUrl = remoteUrlForDisplay(ws.origin).display; // stored: never with a token
    const key = originKey(ws.origin);
    // origin as configured: a token typed into it is masked wherever git quotes it.
    const known = accessSecrets(ws.access, [ws.origin]);
    let check: RemoteCheck;
    let remoteOid: string | null = null;
    let workingOid: string | null = null;
    let read: { refs: OriginRefs; objects: OriginObjects } | null = null;
    // A host key to trust or one that changed: recorded as the read's failure, and also the answer.
    let setup: HttpError | null = null;
    try {
      const refs = await listOriginRefs(ws.path, ws.access);
      remoteOid = refs.branches.get(branch) ?? null;
      workingOid = separate ? (refs.branches.get(workingBranch) ?? null) : remoteOid;
      read = { refs, objects: await bringOriginObjects(ws.path, ws.access, refs, needed) };
      check = { url: checkedUrl, originKey: key, branch, at, published: remoteOid !== null, error: null };
    } catch (error) {
      if (isRunnerUnavailable(error)) throw error; // origin was not read: nothing to record
      remoteOid = null;
      workingOid = null;
      read = null;
      setup = sshSetupError(error);
      const reason = error instanceof HttpError ? error.message : describeGitError(error, known);
      check = { url: checkedUrl, originKey: key, branch, at, published: false, error: reason };
    }
    let stale = false;
    await withMainWorkspaceLock(ws.path, async () => {
      if (!(await this.originStill(projectId, ws))) {
        stale = true; // origin changed meanwhile: its own read counts
        return;
      }
      let tags: { tagsDiffer: string[]; tagsNamedLikeBranches: string[] } | null = null;
      try {
        if (read) tags = await writeOriginRefs(ws.path, read.refs, read.objects, needed);
      } catch (error) {
        if (isRunnerUnavailable(error)) throw error;
        check = { ...check, published: false, error: describeGitError(error, known) };
      }
      try {
        writeRepositorySettings(this.db, projectId, {
          lastRemoteCheck: check,
          ...(tags
            ? { tagsDifferFromOrigin: tags.tagsDiffer, tagsNamedLikeBranches: tags.tagsNamedLikeBranches }
            : {}),
        });
      } catch {
        // the project was deleted meanwhile
      }
    });
    if (setup) throw setup;
    const failed = check.error !== null || stale;
    return {
      main: failed ? null : remoteOid,
      working: failed ? null : workingOid,
      workingBranch,
      error: check.error,
      stale,
    };
  }

  /** Names origin without user info, query or fragment: a token set by hand in it is never echoed. */
  private originExists(current: string, next?: string): HttpError {
    const shown = remoteUrlForDisplay(current);
    const credentialsOnly = next !== undefined && shown.hadCredentials && shown.url === next;
    const message = credentialsOnly
      ? `origin already points at ${shown.display}, with more than the repository's address in its URL, such as a user name or token. Replace it with the clean URL?`
      : `This project already has origin ${shown.display}. Replace it?`;
    return new HttpError(409, 'origin_exists', message, { origin: shown.display, credentialsOnly });
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
      // A read of the origin before is no read of this one, whatever both look like.
      if (current !== url)
        writeRepositorySettings(this.db, projectId, {
          lastRemoteCheck: null,
          tagsDifferFromOrigin: [],
          tagsNamedLikeBranches: [],
        });
    });
  }
}
