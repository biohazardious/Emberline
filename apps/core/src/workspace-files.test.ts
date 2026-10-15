import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteWorkspaceFileEntry,
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
    await expect(writeWorkspaceFileContent(root, 'main', 'link.txt', 'pwned')).rejects.toThrow(/symlink|outside/i);
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
