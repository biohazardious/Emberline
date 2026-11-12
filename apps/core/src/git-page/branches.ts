import path from 'node:path';
import type { BranchRemoteState, GitBranch, GitBranchKind, Run } from '@emberline/protocol';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { isRunnerUnavailable } from '../command-exec.js';
import type { Db } from '../db/index.js';
import {
  type RepositorySettings,
  readRepositorySettings,
  workingBranchOf,
  writeRepositorySettings,
} from '../db/project-settings.js';
import { projects, runs } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { withMainWorkspaceLock } from '../factory/merge.js';
import { execGitFile } from '../git-exec.js';
import {
  isAncestorCommit,
  mainBranchState,
  originUrls,
  pushRef,
  realGit,
  remoteRefHead,
  unlessRunnerUnavailable,
} from '../repository/git.js';
import { keepPushedTarget, type RepositoryService } from '../repository/service.js';
import { worktreeHasUnmergedCommits } from '../runs/git.js';
import { startingWorktrees } from '../runs/starting.js';
import { ACTIVE_RUN_STATES } from '../tickets/columns.js';
import { absentWhen, isPlainRefName } from './history.js';

export interface BranchProject {
  id: string;
  path: string;
  defaultBranch: string;
}

/** Every worktree of the repository (the main workspace first), with the branch it has checked out. */
async function worktreeList(mainPath: string): Promise<{ path: string; branch: string | null }[]> {
  const out = (await execGitFile(['worktree', 'list', '--porcelain'], { cwd: mainPath })).stdout;
  return out
    .split('\n\n')
    .map((entry) => entry.split('\n'))
    .flatMap((lines) => {
      const dir = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (!dir) return [];
      const ref = lines.find((l) => l.startsWith('branch refs/heads/'));
      return [{ path: dir, branch: ref ? ref.slice('branch refs/heads/'.length) : null }];
    });
}

/** The factory's own branches: one per run, never made or chosen by a person. */
const RUN_PREFIX = 'emberline/';

/** A run that a working-branch switch would strand: live, or done with work not merged yet. */
interface LiveRun {
  id: string;
  title: string | null;
  branch: string | null;
}

async function liveRunRows(db: Db, project: BranchProject): Promise<LiveRun[]> {
  const working = workingBranchOf(readRepositorySettings(db, project.id), project.defaultBranch);
  const rows = db
    .select({
      id: runs.id,
      title: runs.title,
      state: runs.state,
      branch: runs.branch,
      worktreePath: runs.worktreePath,
    })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, project.id),
        or(
          inArray(runs.state, [...ACTIVE_RUN_STATES]),
          and(eq(runs.state, 'done'), isNull(runs.cancelledAt)),
        ),
      ),
    )
    .all();
  const live: LiveRun[] = [];
  for (const run of rows) {
    if (ACTIVE_RUN_STATES.has(run.state as Run['state'])) {
      live.push({ id: run.id, title: run.title, branch: run.branch });
      continue;
    }
    // A finished run waits to merge while its worktree holds commits the working branch lacks. A
    // pruned worktree has nothing left to merge (worktreeHasUnmergedCommits answers false without
    // running git), and a row whose "worktree" is the main workspace itself is no run worktree.
    if (!run.branch || path.resolve(run.worktreePath) === path.resolve(project.path)) continue;
    if (await worktreeHasUnmergedCommits(run.worktreePath, working))
      live.push({ id: run.id, title: run.title, branch: run.branch });
  }
  // A run that is starting has its worktree before its row (RunService.enqueue tracks it until the
  // insert): it counts as live, under its worktree's directory name. A worktree left behind with no
  // row (a deleted run, a crash) is not starting, and is judged like any other branch.
  const starting = startingWorktrees(project.path);
  if (starting.length > 0) {
    const known = new Set(
      db
        .select({ worktreePath: runs.worktreePath })
        .from(runs)
        .where(eq(runs.projectId, project.id))
        .all()
        .map((r) => path.resolve(r.worktreePath)),
    );
    for (const w of starting) {
      if (!known.has(w.path))
        live.push({ id: path.basename(w.path), title: 'A run is starting', branch: w.branch });
    }
  }
  return live;
}

/**
 * The project's runs that are live (queued, starting, working, waiting for input or rate limited)
 * or waiting to merge (done, not stopped, with commits the working branch does not have yet).
 */
export async function liveRunsOf(db: Db, projectId: string): Promise<{ id: string; title: string | null }[]> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw notFound('no such project');
  return (await liveRunRows(db, project)).map(({ id, title }) => ({ id, title }));
}

/** A branch name a person typed: a plain name by git's own rules, never an option or `HEAD`. */
async function validBranchName(mainPath: string, name: unknown): Promise<string> {
  const refused = badRequest('Choose a branch name such as feature/login (no spaces, ~, ^, : or "..").');
  if (typeof name !== 'string' || !name || name.startsWith('-') || name === 'HEAD') throw refused;
  if (name.length > 255 || !isPlainRefName(name)) throw refused;
  await execGitFile(['check-ref-format', '--branch', name], { cwd: mainPath }).catch((error: unknown) => {
    if (isRunnerUnavailable(error)) throw error;
    throw refused;
  });
  return name;
}

/** The commit `ref` (a full ref name) names, or null when there is no such ref. */
export async function refTip(mainPath: string, ref: string): Promise<string | null> {
  return realGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], mainPath).then(
    (r) => r.stdout.trim() || null,
    absentWhen(null, 1),
  );
}

export const localTip = (mainPath: string, name: string) => refTip(mainPath, `refs/heads/${name}`);

/** `[ahead, behind]` of `a` against `b`. */
async function counts(mainPath: string, a: string, b: string): Promise<[number, number]> {
  const out = (await realGit(['rev-list', '--left-right', '--count', `${a}...${b}`, '--'], mainPath)).stdout;
  const [ahead, behind] = out.trim().split(/\s+/).map(Number);
  return [ahead ?? 0, behind ?? 0];
}

/**
 * How a local branch stands against origin's: no remote branch is `unpublished`; with no common
 * history at all, origin's was `rewritten` (a filter-repo and force-push), else `diverged`.
 */
export async function classify(
  mainPath: string,
  local: string | null,
  remote: string | null,
): Promise<BranchRemoteState> {
  if (!remote) return 'unpublished';
  if (!local) return 'behind';
  if (local === remote) return 'up_to_date';
  if (await isAncestorCommit(mainPath, local, remote)) return 'behind';
  if (await isAncestorCommit(mainPath, remote, local)) return 'ahead';
  // merge-base exits 1 for "no common commit"; any other failure is a real one.
  const base = await realGit(['merge-base', local, remote], mainPath).then(
    (r) => r.stdout.trim(),
    absentWhen('', 1),
  );
  return base ? 'diverged' : 'rewritten';
}

const kindOf = (name: string, working: string, main: string): GitBranchKind =>
  name === working ? 'working' : name === main ? 'main' : name.startsWith(RUN_PREFIX) ? 'run' : 'person';

/** The branches whose tip is in `target`'s history, in one call. */
async function mergedInto(mainPath: string, target: string | null): Promise<Set<string>> {
  if (!target) return new Set();
  const out = (
    await realGit(['for-each-ref', `--merged=${target}`, '--format=%(refname)', 'refs/heads/'], mainPath)
  ).stdout;
  return new Set(out.split('\n').filter(Boolean));
}

/** Branches are read a few at a time: each costs up to four git calls in the runner. */
const BRANCH_READS_AT_ONCE = 8;

/**
 * Every local branch, run branches included (the page hides those itself), with where it stands
 * against main and against origin as last read (`refs/remotes/origin/<b>`; no network here).
 */
export async function listBranches(
  db: Db,
  project: BranchProject,
  settings: RepositorySettings,
): Promise<GitBranch[]> {
  const main = project.defaultBranch;
  const working = workingBranchOf(settings, main);
  const out = (
    await realGit(
      [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(contents:subject)%00',
        'refs/heads/',
        'refs/remotes/origin/',
      ],
      project.path,
    )
  ).stdout;
  const fields = out.split('\0');
  const local: { name: string; tip: string; subject: string }[] = [];
  const tracking = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const ref = (fields[i] as string).replace(/^\n/, '');
    const oid = fields[i + 1] as string;
    if (ref.startsWith('refs/heads/'))
      local.push({ name: ref.slice('refs/heads/'.length), tip: oid, subject: fields[i + 2] as string });
    else tracking.set(ref.slice('refs/remotes/origin/'.length), oid);
  }
  const mainTip = local.find((b) => b.name === main)?.tip ?? null;
  const workingTip = local.find((b) => b.name === working)?.tip ?? null;
  const [hasOrigin, inMain, inWorking, live] = await Promise.all([
    originUrls(project.path).then((o) => o.fetch !== null),
    mergedInto(project.path, mainTip),
    mergedInto(project.path, workingTip),
    liveRunRows(db, project),
  ]);

  const read = async ({ name, tip, subject }: (typeof local)[number]): Promise<GitBranch> => {
    let vsMain: GitBranch['vsMain'] = null;
    if (mainTip && name !== main) {
      const [ahead, behind] = await counts(project.path, tip, mainTip);
      vsMain = { ahead, behind };
    }
    let vsOrigin: GitBranch['vsOrigin'] = null;
    const remote = tracking.get(name);
    if (hasOrigin && !remote) vsOrigin = { state: 'unknown', ahead: null, behind: null };
    if (hasOrigin && remote) {
      const state = await classify(project.path, tip, remote);
      const [ahead, behind] = state === 'rewritten' ? [null, null] : await counts(project.path, tip, remote);
      vsOrigin = { state, ahead, behind };
    }
    return {
      name,
      kind: kindOf(name, working, main),
      tip,
      subject,
      vsMain,
      vsOrigin,
      mergedIntoMain: inMain.has(`refs/heads/${name}`),
      mergedIntoWorking: inWorking.has(`refs/heads/${name}`),
      liveRuns: live.filter((r) => r.branch === name).map((r) => r.id),
    };
  };
  const branches: GitBranch[] = [];
  for (let i = 0; i < local.length; i += BRANCH_READS_AT_ONCE) {
    branches.push(...(await Promise.all(local.slice(i, i + BRANCH_READS_AT_ONCE).map(read))));
  }
  return branches;
}

/** A new branch at main's or the working branch's tip; nothing is checked out. */
export async function createBranch(
  project: BranchProject,
  rawName: unknown,
  from: 'main' | 'working',
  working: string,
): Promise<void> {
  const name = await validBranchName(project.path, rawName);
  if (name.startsWith(RUN_PREFIX))
    throw badRequest(`Branches under ${RUN_PREFIX} are the factory's run branches; choose another name.`);
  const source = from === 'main' ? project.defaultBranch : working;
  await withMainWorkspaceLock(project.path, async () => {
    if (await localTip(project.path, name))
      throw conflict(`There is a branch ${name} already.`, 'branch_exists');
    const tip = await localTip(project.path, source);
    if (!tip) throw conflict(`${source} has no commits yet.`, 'no_commits');
    // The empty old value makes this a create: git refuses it if the branch appeared meanwhile.
    await execGitFile(
      ['update-ref', '-m', `emberline: branch from ${source}`, `refs/heads/${name}`, tip, ''],
      { cwd: project.path },
    ).catch((error: unknown) => {
      if (isRunnerUnavailable(error)) throw error;
      throw conflict(`Could not create ${name}: ${gitMessage(error)}`, 'branch_exists');
    });
  });
}

/** git's own words from a failed command, all of them (a file list included), on one line. */
export function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : String(error);
  return text
    .split('\n')
    .map((l) => l.replace(/^(?:fatal|error|hint): /, '').trim())
    .filter((l) => l && l !== 'Aborting')
    .join(' ')
    .slice(0, 1000);
}

/** The branches checked out in the main workspace or in any worktree (runs' included). */
export async function checkedOutBranches(mainPath: string): Promise<Set<string>> {
  return new Set((await worktreeList(mainPath)).flatMap((w) => (w.branch === null ? [] : [w.branch])));
}

/** Whether `oid` is already in main's or the working branch's history: deleting it loses nothing. */
async function mergedSomewhere(mainPath: string, oid: string, main: string, working: string) {
  return (
    (await isAncestorCommit(mainPath, oid, `refs/heads/${main}`)) ||
    (working !== main && (await isAncestorCommit(mainPath, oid, `refs/heads/${working}`)))
  );
}

/**
 * Under the lock: whether `name` may be deleted, and the commit it names. Never the default branch,
 * the working branch, a branch checked out anywhere or used by a live run, or one with commits
 * that neither main nor the working branch has (`git branch -d`'s rule, against both).
 */
async function deletable(db: Db, project: BranchProject, name: string): Promise<string> {
  const working = workingBranchOf(readRepositorySettings(db, project.id), project.defaultBranch);
  if (name === project.defaultBranch)
    throw conflict(`${name} is the default branch; Emberline never deletes it.`, 'branch_protected');
  if (name === working)
    throw conflict(
      `${name} is the working branch; choose another working branch before deleting it.`,
      'branch_protected',
    );
  const tip = await localTip(project.path, name);
  if (!tip) throw notFound(`There is no branch ${name}.`);
  if ((await checkedOutBranches(project.path)).has(name))
    throw conflict(`${name} is checked out in a worktree, so it stays.`, 'branch_checked_out');
  const users = (await liveRunRows(db, project)).filter((r) => r.branch === name);
  if (users.length > 0)
    throw new HttpError(409, 'branch_in_use', `${name} is used by a run that is live or waiting to merge.`, {
      runs: users.map(({ id, title }) => ({ id, title })),
    });
  if (!(await mergedSomewhere(project.path, tip, project.defaultBranch, working)))
    throw conflict(
      `${name} has commits that are not in ${project.defaultBranch} or ${working}, so deleting it would lose them.`,
      'branch_unmerged',
    );
  return tip;
}

export interface DeleteBranchResult {
  /** On origin: deleted, already gone, or not asked (no tick). */
  remote: 'deleted' | 'already_gone' | null;
  message: string;
}

/**
 * Deletes a fully merged branch here and, only with `remote` (the person's tick), on origin too.
 * Origin goes first, so a refusal there leaves both as they were. Origin's branch is deleted only
 * as the commit Emberline read, and only when that commit is in main or the working branch here.
 * The local delete is a compare-and-delete of the commit checked under the lock.
 */
export async function deleteBranch(
  db: Db,
  project: BranchProject,
  rawName: unknown,
  remote: boolean,
  repository: Pick<RepositoryService, 'remoteAction'>,
): Promise<DeleteBranchResult> {
  const name = await validBranchName(project.path, rawName);
  const tip = await withMainWorkspaceLock(project.path, () => deletable(db, project, name));
  let onOrigin: DeleteBranchResult['remote'] = null;
  if (remote) {
    onOrigin = await repository.remoteAction(project.id, async (ws) => {
      const ref = `refs/heads/${name}`;
      const theirs = await remoteRefHead(ws.path, ws.access, ref);
      let outcome: 'deleted' | 'already_gone' = 'already_gone';
      if (theirs !== null) {
        const working = workingBranchOf(readRepositorySettings(db, project.id), project.defaultBranch);
        if (!(await mergedSomewhere(ws.path, theirs, project.defaultBranch, working)))
          throw conflict(
            `origin's ${name} has commits that are not in ${project.defaultBranch} or ${working} here, so Emberline deleted nothing (here or on origin). Bring them in first, or delete it on the forge.`,
            'remote_unmerged',
          );
        const pushed = await pushRef(ws.path, ws.access, { ref, newOid: null, expectOld: theirs });
        if (pushed === 'rejected') {
          // Gone meanwhile is what was asked; moved on is not deleted.
          if ((await remoteRefHead(ws.path, ws.access, ref)) !== null)
            throw conflict(
              `origin's ${name} changed while Emberline was deleting it, so nothing was deleted (here or on origin). Look again and retry.`,
              'remote_moved',
            );
        } else outcome = 'deleted';
      }
      // What Emberline last read of it no longer stands.
      await withMainWorkspaceLock(ws.path, () =>
        execGitFile(['update-ref', '-d', `refs/remotes/origin/${name}`], { cwd: ws.path }).catch(
          unlessRunnerUnavailable(undefined),
        ),
      );
      return outcome;
    });
  }
  await withMainWorkspaceLock(project.path, async () => {
    if ((await deletable(db, project, name)) !== tip)
      throw conflict(
        `${name} moved while it was being deleted, so it stays here${onOrigin === 'deleted' ? ' (on origin it is deleted)' : ''}. Look again.`,
        'branch_moved',
      );
    await execGitFile(['update-ref', '-m', 'emberline: branch deleted', '-d', `refs/heads/${name}`, tip], {
      cwd: project.path,
    });
  });
  const message =
    onOrigin === 'deleted'
      ? `Deleted ${name} here and on origin.`
      : onOrigin === 'already_gone'
        ? `Deleted ${name}; it was already gone on origin.`
        : `Deleted ${name}.`;
  return { remote: onOrigin, message };
}

/** git's refusal to change files a person edited (or untracked files in the way). */
export const WORKSPACE_DIRTY =
  /would be overwritten|commit your changes or stash|untracked working tree files/i;

/**
 * Makes `rawBranch` the working branch: refused while any run is live or waiting to merge (a run
 * based on the old branch would merge into the new one). A branch only on origin (as last read)
 * becomes a local branch at that commit first. The main workspace then checks it out, never by
 * force, which also makes it the branch runs merge into.
 */
export async function setWorkingBranch(db: Db, project: BranchProject, rawBranch: unknown): Promise<void> {
  const branch = await validBranchName(project.path, rawBranch);
  await withMainWorkspaceLock(project.path, async () => {
    const current = workingBranchOf(readRepositorySettings(db, project.id), project.defaultBranch);
    const live = await liveRunRows(db, project);
    if (live.length > 0) {
      const names = live.map((r) => r.title ?? r.id).join(', ');
      throw new HttpError(
        409,
        'runs_live',
        `The working branch stays ${current} while runs are live or waiting to merge: ${names}. Let them finish and merge, or stop them, then switch.`,
        { runs: live.map(({ id, title }) => ({ id, title })) },
      );
    }
    if (!(await localTip(project.path, branch))) {
      const theirs = await refTip(project.path, `refs/remotes/origin/${branch}`);
      if (!theirs) throw notFound(`There is no branch ${branch} here or on origin (as last read).`);
      await execGitFile(
        ['update-ref', '-m', 'emberline: branch from origin', `refs/heads/${branch}`, theirs, ''],
        { cwd: project.path },
      );
    }
    const { branch: checkedOut } = await mainBranchState(project.path);
    if (checkedOut !== branch) {
      try {
        await execGitFile(['switch', '--no-guess', branch], { cwd: project.path });
      } catch (error) {
        if (isRunnerUnavailable(error)) throw error;
        const why = gitMessage(error);
        if (WORKSPACE_DIRTY.test(why))
          throw conflict(
            `The main workspace has changes that switching would overwrite: ${why}`,
            'workspace_dirty',
          );
        throw conflict(`Could not switch the main workspace to ${branch}: ${why}`, 'switch_failed');
      }
    }
    const before = readRepositorySettings(db, project.id);
    const next = { ...before, workingBranch: branch === project.defaultBranch ? undefined : branch };
    // A Keep pushed failure of the old branch says nothing about the new one.
    const targetChanged =
      keepPushedTarget(next, project.defaultBranch) !== keepPushedTarget(before, project.defaultBranch);
    writeRepositorySettings(db, project.id, {
      workingBranch: next.workingBranch,
      ...(targetChanged ? { lastMainPushError: null } : {}),
    });
  });
}
