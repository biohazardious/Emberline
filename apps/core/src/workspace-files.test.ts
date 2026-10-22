import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteWorkspaceFileEntry,
  listWorkspaceFilesFlat,
  readWorkspaceFileContent,
  readWorkspaceFileRaw,
  uploadWorkspaceFiles,
  writeWorkspaceFileContent,
} from './factory/service.js';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'ws-files-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('workspace file explorer containment', () => {
  it('reads and writes regular files inside the workspace', async () => {
    await writeWorkspaceFileContent(root, 'main', 'src/new/file.ts', 'const a = 1;\n');
    const res = await readWorkspaceFileContent(root, 'main', 'src/new/file.ts');
    expect(res.content).toBe('const a = 1;\n');
  });

  it('refuses to read or download through a symlink that leaves the workspace', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'README.md'));
    await expect(readWorkspaceFileContent(root, 'main', 'README.md')).rejects.toThrow(/symlink|outside/i);
    await expect(readWorkspaceFileRaw(root, 'README.md')).rejects.toThrow(/symlink|outside/i);
  });

  it('refuses to write through a symlinked file or directory', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    symlinkSync(outside, path.join(root, 'linked-dir'));
    await expect(writeWorkspaceFileContent(root, 'main', 'link.txt', 'pwned')).rejects.toThrow(
      /symlink|outside/i,
    );
    await expect(writeWorkspaceFileContent(root, 'main', 'linked-dir/new.txt', 'pwned')).rejects.toThrow(
      /symlink|outside/i,
    );
    await expect(
      uploadWorkspaceFiles(root, 'main', [{ path: 'linked-dir/up.bin', dataBase64: 'AAAA' }]),
    ).rejects.toThrow(/symlink|outside/i);
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(existsSync(path.join(outside, 'up.bin'))).toBe(false);
  });

  it('deletes a symlink itself, never its target', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await deleteWorkspaceFileEntry(root, 'link.txt');
    expect(existsSync(path.join(root, 'link.txt'))).toBe(false);
    expect(existsSync(path.join(outside, 'secret.txt'))).toBe(true);
  });
});

describe('the explorer lists .emberline/worktree.yml and nothing else under .emberline', () => {
  const paths = async () => (await listWorkspaceFilesFlat(root)).map((e) => `${e.kind}:${e.path}`);

  it('lists the folder and worktree.yml, not the scratch files or a nested .emberline', async () => {
    mkdirSync(path.join(root, '.emberline'));
    writeFileSync(path.join(root, '.emberline', 'worktree.yml'), 'version: 1\n');
    writeFileSync(path.join(root, '.emberline', 'new-tickets.json'), '[]');
    mkdirSync(path.join(root, 'src', '.emberline'));
    writeFileSync(path.join(root, 'src', '.emberline', 'worktree.yml'), 'version: 1\n');
    const listed = await paths();
    expect(listed).toContain('directory:.emberline');
    expect(listed).toContain('file:.emberline/worktree.yml');
    expect(listed.filter((p) => p.includes('.emberline'))).toEqual([
      'directory:.emberline',
      'file:.emberline/worktree.yml',
    ]);
    const entry = (await listWorkspaceFilesFlat(root)).find((e) => e.path === '.emberline/worktree.yml');
    expect(entry).toMatchObject({ name: 'worktree.yml', kind: 'file', sizeBytes: 'version: 1\n'.length });
  });

  it('does not list a symlinked worktree.yml, a symlinked .emberline or a folder without the file', async () => {
    mkdirSync(path.join(root, '.emberline'));
    writeFileSync(path.join(root, '.emberline', 'new-tickets.json'), '[]');
    expect((await paths()).some((p) => p.includes('.emberline'))).toBe(false);
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, '.emberline', 'worktree.yml'));
    expect((await paths()).some((p) => p.includes('.emberline'))).toBe(false);
    rmSync(path.join(root, '.emberline'), { recursive: true });
    writeFileSync(path.join(outside, 'worktree.yml'), 'version: 1\n');
    symlinkSync(outside, path.join(root, '.emberline'));
    expect((await paths()).some((p) => p.includes('.emberline'))).toBe(false);
  });
});
