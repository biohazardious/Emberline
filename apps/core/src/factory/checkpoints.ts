/** Main-workspace checkpoints (git history), rollback and project archive export. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type ProjectCheckpoint } from '@emberline/protocol';
import { execGitFile } from '../git-exec.js';

const execFileAsync = promisify(execFile);

// --- F9: Checkpoints, Rollback & Project Archive Export ---------------------

export async function listProjectCheckpoints(workspacePath: string): Promise<ProjectCheckpoint[]> {
  if (!existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const { stdout } = await execGitFile(
      ['log', '-n', '25', '--pretty=format:%H%x09%h%x09%s%x09%an%x09%cI'],
      { cwd: workspacePath },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha = '', shortSha = '', subject = '', author = '', createdAt = ''] = line.split('\t');
        return { sha, shortSha, subject, author, createdAt };
      })
      .filter((c) => Boolean(c.sha));
  } catch {
    return [];
  }
}

export async function rollbackProjectCheckpoint(
  workspacePath: string,
  sha: string,
): Promise<{ ok: boolean; sha: string; summary: string }> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha.trim())) {
    throw new Error('Invalid commit SHA');
  }
  await execGitFile(['reset', '--hard', sha.trim()], { cwd: workspacePath });
  return {
    ok: true,
    sha: sha.trim(),
    summary: `Main workspace rolled back to checkpoint ${sha.trim().slice(0, 8)}.`,
  };
}

export async function exportProjectTarGz(workspacePath: string): Promise<Buffer> {
  // S19: a private directory per export; a shared timestamped name collided for concurrent exports.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'emberline-export-'));
  const tmpFile = path.join(tmpDir, 'export.tar.gz');
  try {
    // The one local process core still starts: the image's own tar only reads files (symlinks are
    // archived as links, never followed), so nothing from the workspace executes.
    await execFileAsync(
      'tar',
      ['-czf', tmpFile, '--exclude=.git', '--exclude=node_modules', '--exclude=.emberline', '.'],
      { cwd: workspacePath, timeout: 60_000 },
    );
    return await readFile(tmpFile);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
