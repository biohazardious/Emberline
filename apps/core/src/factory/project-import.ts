/**
 * Importing existing repositories: the workspace folders that can be registered in place, the
 * status of a clone, and adopt (write the missing Emberline files, commit them, store choices,
 * gates and the approved worktree.yml).
 */
import { stripVTControlCharacters } from 'node:util';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  ADOPT_COMMIT_MESSAGE,
  ADOPT_FILE_PATHS,
  type AdoptPreviewResponse,
  type AdoptProjectBody,
  type AdoptWriteFile,
  type ImportStatusResponse,
  type Project,
  type ProjectAppType,
  type ProjectChoices,
  type WorkspaceFolder,
} from '@emberline/protocol';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { execGitFile, UnsafeGitConfigError } from '../git-exec.js';
import { createExclusiveFile, isMissing, openFileUnder, realDirUnder, UnsafePathError } from '../outputs/safe-fs.js';
import type { PtydBridge } from '../ptyd-bridge.js';
import { parseWorktreeYml } from '../worktree-config/load.js';
import { importFileContents, inspectImportedProject } from './detect.js';
import { FACTORY_GIT_IDENTITY, mainWorkspaceBranch, withMainWorkspaceLock } from './merge.js';
import { validateChoices } from './project-plan.js';

const ADOPT_ORDER: readonly AdoptWriteFile[] = ['projectMd', 'claudeMd', 'worktreeYml'];
const TAIL_CHARS = 4000;

/** A name of a folder core never offers or registers (hidden, `.worktrees`, `.emberline-outputs`, ...). */
const isHiddenName = (name: string) => name.startsWith('.');

async function isGitRepo(dir: string): Promise<boolean> {
  return lstat(path.join(dir, '.git')).then(
    () => true,
    () => false,
  );
}

/** Whether the repository config names a remote; read without following links, no git process. */
async function hasRemote(workspacesDir: string, dir: string): Promise<boolean> {
  let opened;
  try {
    opened = await openFileUnder(workspacesDir, dir, path.join('.git', 'config'));
  } catch {
    // `.git` is a file (linked worktree, submodule), a link, or has no config: no remote we can see.
    return false;
  }
  try {
    const size = Math.min(opened.size, 256 * 1024);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await opened.handle.read(buffer, 0, size, 0);
    return /^\s*\[remote\s+"/m.test(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Direct children of the workspaces directory that can be imported: real directories (no links),
 * not hidden and not a project's folder already.
 */
export async function listWorkspaceFolders(workspacesDir: string, projectPaths: readonly string[]): Promise<WorkspaceFolder[]> {
  const base = await realpath(workspacesDir);
  const taken = new Set(projectPaths.map((p) => path.resolve(p)));
  const entries = await readdir(workspacesDir, { withFileTypes: true });
  const folders: WorkspaceFolder[] = [];
  for (const entry of entries) {
    // A Dirent for a symlink is never a directory: linked entries are left out here.
    if (!entry.isDirectory() || isHiddenName(entry.name)) continue;
    const abs = path.join(workspacesDir, entry.name);
    if (taken.has(path.resolve(abs))) continue;
    const real = await realpath(abs).catch(() => null);
    if (real !== path.join(base, entry.name) || taken.has(real)) continue;
    const repo = await isGitRepo(abs);
    folders.push({ name: entry.name, path: abs, isGitRepo: repo, hasRemote: repo && (await hasRemote(workspacesDir, abs)) });
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

/** The folder an `import_folder` create names: a real, visible direct child of the workspaces directory. */
export async function resolveWorkspaceFolder(workspacesDir: string, folder: string): Promise<string> {
  if (isHiddenName(folder) || folder.includes('/') || folder.includes('\\')) {
    throw badRequest(`"${folder}" is not a folder that can be imported`);
  }
  const abs = path.join(workspacesDir, folder);
  let stats;
  try {
    stats = await lstat(abs);
  } catch (error) {
    if (isMissing(error)) throw notFound(`no folder "${folder}" in the workspaces directory`);
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw badRequest(`"${folder}" is not a folder (links are not imported)`);
  try {
    await realDirUnder(workspacesDir, abs);
  } catch (error) {
    if (error instanceof UnsafePathError) throw badRequest(`"${folder}" is reached through a link`);
    throw error;
  }
  return abs;
}

/** True when `dir` is itself a git repository whose HEAD names a commit. */
export async function hasHeadCommit(dir: string): Promise<boolean> {
  if (!(await isGitRepo(dir))) return false;
  return execGitFile(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: dir }).then(
    () => true,
    () => false,
  );
}

/** Checks an import folder is a git repository with a commit; returns its checked-out branch. */
export async function inspectImportFolder(dir: string): Promise<{ branch: string | null }> {
  const hint = 'initialise git first: run `git init` and make a first commit in it, then import it';
  if (!(await isGitRepo(dir))) throw conflict(`the folder is not a git repository; ${hint}`);
  try {
    await execGitFile(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: dir });
  } catch (error) {
    if (error instanceof UnsafeGitConfigError) throw conflict(error.message);
    throw conflict(`the repository has no commit yet; ${hint}`);
  }
  return { branch: await mainWorkspaceBranch(dir) };
}

/** The last lines of a terminal, as plain text. */
async function terminalTail(ptyd: PtydBridge, sessionId: string): Promise<string> {
  try {
    const snap = await ptyd.get().snapshot(sessionId, 200);
    const lines = stripVTControlCharacters(snap.data ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd());
    while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n').slice(-TAIL_CHARS);
  } catch {
    return '';
  }
}

/** Latest clone terminal of a project, if ptyd knows one. */
function latestClone<T extends { meta: Record<string, string>; createdAt: string }>(sessions: T[], projectId: string): T | undefined {
  return sessions
    .filter((s) => s.meta.kind === 'clone' && s.meta.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Refuses detection and adopt while the project's clone is still writing the folder. Starts no process. */
export async function assertNotCloning(ptyd: PtydBridge, projectId: string): Promise<void> {
  let sessions;
  try {
    sessions = (await ptyd.get().list()).sessions;
  } catch {
    // Runner unreachable: the clone state is unknown here; the folder checks that follow still apply.
    return;
  }
  if (latestClone(sessions, projectId)?.status === 'running') throw conflict('the repository is still being cloned');
}

/**
 * `cloning` while the clone terminal runs; `ready` once it exited 0 and the folder has a commit;
 * `failed` otherwise. A project without a clone terminal (registered in place, or ptyd forgot it)
 * is judged by its folder alone.
 */
export async function importStatus(ptyd: PtydBridge, project: Project): Promise<ImportStatusResponse> {
  let sessions;
  try {
    sessions = (await ptyd.get().list()).sessions;
  } catch (error) {
    if (await hasHeadCommit(project.path)) return { status: 'ready', exitCode: null, terminalId: null, tail: '' };
    throw error;
  }
  const clone = latestClone(sessions, project.id);
  if (!clone) {
    const ready = await hasHeadCommit(project.path);
    return {
      status: ready ? 'ready' : 'failed',
      exitCode: null,
      terminalId: null,
      tail: ready ? '' : 'No clone terminal for this project, and its folder has no commit.',
    };
  }
  const tail = await terminalTail(ptyd, clone.id);
  const base = { exitCode: clone.exitCode, terminalId: clone.id, tail };
  if (clone.status === 'running') return { ...base, status: 'cloning' };
  if (clone.exitCode === 0 && (await hasHeadCommit(project.path))) return { ...base, status: 'ready' };
  if (clone.exitCode === 0) return { ...base, status: 'failed', tail: `${tail}\nThe clone has no commit (empty repository?).`.trim() };
  return { ...base, status: 'failed' };
}

export type AdoptInput = ReturnType<typeof AdoptProjectBody.parse>;

export interface AdoptPlan extends AdoptPreviewResponse {
  appType: ProjectAppType;
  choices: ProjectChoices;
  /** Content to store as the approved worktree.yml, when there is one. */
  approvedWorktreeYml: string | null;
}

/** What adopt writes and approves; refuses (409/400) before anything is touched. No side effects. */
export async function planAdopt(workspacesDir: string, project: Project, body: AdoptInput): Promise<AdoptPlan> {
  const appType = body.appType ?? project.appType;
  validateChoices(body.choices, appType);
  const detected = await inspectImportedProject(workspacesDir, project.path);
  const write = ADOPT_ORDER.filter((key) => body.write.includes(key));
  for (const key of write) {
    if (detected.files[key]) {
      throw conflict(`${ADOPT_FILE_PATHS[key]} already exists in the repository; Emberline never overwrites it`);
    }
  }
  const contents = importFileContents({
    name: project.name,
    appType,
    description: body.vision || project.description,
    choices: body.choices,
    commands: detected.commands,
  });
  const files = Object.fromEntries(write.map((key) => [ADOPT_FILE_PATHS[key], contents[key]]));

  let worktreeConfig: AdoptPlan['worktreeConfig'] = null;
  let approvedWorktreeYml: string | null = null;
  if (write.includes('worktreeYml')) {
    worktreeConfig = 'generated';
    approvedWorktreeYml = contents.worktreeYml;
  } else if (body.approveWorktreeYml) {
    const own = detected.worktreeYml;
    if (!own) throw badRequest('the repository has no .emberline/worktree.yml to approve');
    if (own.content === null) {
      throw new HttpError(400, 'invalid_worktree_yml', `.emberline/worktree.yml cannot be approved: ${own.errors.join('; ')}`, { errors: own.errors });
    }
    if (own.sha256 !== body.worktreeYmlSha256) {
      throw conflict('.emberline/worktree.yml changed since you reviewed it; review it again');
    }
    // Detection parsed this very content; re-check so a stale schema result can never slip through.
    const parsed = parseWorktreeYml(own.content);
    if (!parsed.ok) {
      throw new HttpError(400, 'invalid_worktree_yml', `.emberline/worktree.yml is not valid: ${parsed.errors.join('; ')}`, { errors: parsed.errors });
    }
    worktreeConfig = 'existing';
    approvedWorktreeYml = own.content;
  }
  return {
    files,
    commitMessage: write.length > 0 ? ADOPT_COMMIT_MESSAGE : null,
    worktreeConfig,
    appType,
    choices: body.choices,
    approvedWorktreeYml,
  };
}

/** Creates each file exclusively (never replacing anything) through verified directories. */
async function writeNewFiles(workspacesDir: string, projectPath: string, files: Record<string, string>): Promise<() => Promise<void>> {
  const created: string[] = [];
  const createdDirs: string[] = [];
  const undo = async () => {
    for (const file of created.reverse()) await unlink(file).catch(() => undefined);
    for (const dir of createdDirs.reverse()) await rmdir(dir).catch(() => undefined);
  };
  try {
    for (const [rel, content] of Object.entries(files)) {
      const parent = path.join(projectPath, path.dirname(rel));
      if (path.dirname(rel) !== '.') {
        await mkdir(parent).then(
          () => createdDirs.push(parent),
          (error: unknown) => {
            if ((error as { code?: string }).code !== 'EEXIST') throw error;
          },
        );
      }
      const realParent = await realDirUnder(workspacesDir, parent);
      if (!realParent) throw new Error(`${path.dirname(rel)} disappeared`);
      let handle;
      try {
        handle = await createExclusiveFile(realParent, path.basename(rel));
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') {
          throw conflict(`${rel} already exists in the repository; Emberline never overwrites it`);
        }
        throw error;
      }
      created.push(path.join(realParent, path.basename(rel)));
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    await undo();
    if (error instanceof UnsafePathError) throw conflict(`cannot write into the repository safely: ${error.message}`);
    if ((error as { code?: string }).code === 'ENOTDIR') throw conflict('.emberline exists in the repository and is not a folder');
    throw error;
  }
  return undo;
}

export interface AdoptResult extends AdoptPlan {
  commitSha: string | null;
}

/**
 * Writes the planned files and commits exactly those paths on the checked-out branch (a local
 * commit; nothing is pushed). Other staged or unstaged work in the repository is left as it was.
 * Runs under the main-workspace lock so it never interleaves with a merge.
 */
export async function executeAdopt(workspacesDir: string, project: Project, body: AdoptInput): Promise<AdoptResult> {
  return withMainWorkspaceLock(project.path, async () => {
    const plan = await planAdopt(workspacesDir, project, body);
    const paths = Object.keys(plan.files);
    if (paths.length === 0 || !plan.commitMessage) return { ...plan, commitSha: null };

    const branch = await mainWorkspaceBranch(project.path);
    if (!branch) throw conflict('the repository has no branch checked out; check one out, then adopt again');
    const undo = await writeNewFiles(workspacesDir, project.path, plan.files);
    const inRepo = { cwd: project.path };
    try {
      // -f: a repo that ignores .emberline/ still gets the file the person asked to commit.
      await execGitFile(['add', '-f', '--', ...paths], inRepo);
      // A commit with paths takes only those paths, whatever else is staged.
      await execGitFile([...FACTORY_GIT_IDENTITY, 'commit', '-q', '--no-verify', '-m', plan.commitMessage, '--', ...paths], inRepo);
    } catch (error) {
      await execGitFile(['reset', '-q', '--', ...paths], inRepo).catch(() => undefined);
      await undo();
      throw error;
    }
    const commitSha = (await execGitFile(['rev-parse', 'HEAD'], inRepo)).stdout.trim();
    return { ...plan, commitSha };
  });
}
