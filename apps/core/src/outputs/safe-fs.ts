/**
 * File access on the workspaces volume, which agents (same UID as core) can change at any moment.
 *
 * Checking a path and then opening it by name lets an agent swap a symlink in between (TOCTOU) and
 * make core read or write a file outside the place it checked, e.g. core's database under /data.
 * So files are opened once with O_NOFOLLOW (and O_NONBLOCK, so a FIFO swapped in cannot block the
 * open), and the opened descriptor is checked: `/proc/self/fd/<fd>` must name exactly the expected
 * path and fstat must report a regular file. Reads, sizes and copies then go through that fd.
 *
 * Node has no openat/unlinkat, so renames and unlinks still go by path; they are done inside a
 * directory whose real path was verified just before, and an unlink never follows the final
 * component. A swap of a directory in that last window can at worst move or unlink a file with a
 * deliverable's name; it can never make core read a file it did not verify.
 */
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readlink, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fsConstants;
const COPY_CHUNK = 1024 * 1024;

/** A path that is (or might be) reached through a link, or is not a regular file. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const codeOf = (error: unknown) => (error as { code?: string }).code;
/** The path is not there (a missing component counts). */
export const isMissing = (error: unknown) => codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR';

/** The path the kernel has for an open descriptor (Linux). */
export async function fdPath(handle: FileHandle): Promise<string> {
  return readlink(`/proc/self/fd/${handle.fd}`);
}

export interface OpenedFile {
  handle: FileHandle;
  size: number;
  mtime: Date;
}

/**
 * Opens `abs` for reading without following links; the descriptor must name `expectedReal` and be a
 * regular file. Throws UnsafePathError otherwise (ELOOP from O_NOFOLLOW included), and the plain
 * error when the file is missing. The caller closes the handle.
 */
export async function openVerifiedFile(abs: string, expectedReal: string): Promise<OpenedFile> {
  let handle: FileHandle;
  try {
    handle = await open(abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === 'ELOOP') throw new UnsafePathError(`${abs} is a symbolic link`);
    throw error;
  }
  try {
    const actual = await fdPath(handle);
    if (actual !== expectedReal) throw new UnsafePathError(`${abs} resolves outside the expected place`);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new UnsafePathError(`${abs} is not a regular file`);
    return { handle, size: stats.size, mtime: stats.mtime };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Opens `relPath` (already validated as relative and inside, e.g. by resolveSafeWorktreePath) under
 * `rootDir` for reading: the file must really be `realpath(rootDir)/relPath`, reached without links.
 */
export async function openFileUnder(rootDir: string, relPath: string): Promise<OpenedFile> {
  const realRoot = await realpath(rootDir);
  return openVerifiedFile(path.join(rootDir, relPath), path.join(realRoot, relPath));
}

/** Creates `name` in the verified directory `realDir`; fails if anything already exists there. */
export async function createExclusiveFile(realDir: string, name: string): Promise<FileHandle> {
  const target = path.join(realDir, name);
  const handle = await open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  try {
    if ((await fdPath(handle)) !== target)
      throw new UnsafePathError(`${target} was created outside its directory`);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Copies exactly `size` bytes from `src` to `dst` (both open descriptors). */
export async function copyBetweenHandles(src: FileHandle, dst: FileHandle, size: number): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(size, COPY_CHUNK)));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await src.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead === 0) throw new Error('the file shrank while it was copied');
    let written = 0;
    while (written < bytesRead) {
      const { bytesWritten } = await dst.write(buffer, written, bytesRead - written, position + written);
      written += bytesWritten;
    }
    position += bytesRead;
  }
}

/** A download stream of exactly `size` bytes from an opened file; it closes the handle when done. */
export function streamOpenedFile({ handle, size }: OpenedFile): Readable {
  if (size === 0) {
    void handle.close().catch(() => undefined);
    return Readable.from([]);
  }
  return handle.createReadStream({ start: 0, end: size - 1 });
}

/**
 * A directory owned by core inside a base directory it trusts (the archive under the workspaces
 * root). Paths are relative to it; none may leave it, and no component of one may be a link.
 */
export class SafeRoot {
  readonly root: string;

  constructor(
    private readonly trustedBase: string,
    private readonly dirName: string,
  ) {
    this.root = path.join(trustedBase, dirName);
  }

  /** Lexically resolves a relative path; anything that leaves the root (or is the root) is refused. */
  resolve(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
      throw new UnsafePathError('invalid path');
    }
    const abs = path.resolve(this.root, normalized);
    const rel = path.relative(this.root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
      throw new UnsafePathError('path outside the root');
    return abs;
  }

  /** Where `relPath` must really be when no component of it is a link. */
  async expectedReal(relPath = ''): Promise<string> {
    const base = path.join(await realpath(this.trustedBase), this.dirName);
    return relPath ? path.join(base, path.relative(this.root, this.resolve(relPath))) : base;
  }

  /** True when the root is a real directory (never a link); created when asked. */
  async rootIsRealDir(opts: { create?: boolean } = {}): Promise<boolean> {
    const info = await lstat(this.root).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (info) return info.isDirectory();
    if (!opts.create) return false;
    await mkdir(this.root, { recursive: true });
    return (await lstat(this.root)).isDirectory();
  }

  /**
   * The real path of directory `relDir`, verified to contain no link. Creates it when asked (only
   * under a root that is a real directory). Null when it does not exist and was not to be created.
   */
  async realDir(relDir: string, opts: { create?: boolean } = {}): Promise<string | null> {
    if (!(await this.rootIsRealDir({ create: opts.create }))) {
      const rootMissing = !(await lstat(this.root).catch(() => null));
      if (rootMissing) return null;
      throw new UnsafePathError('the root is not a plain directory');
    }
    const abs = this.resolve(relDir);
    if (opts.create) await mkdir(abs, { recursive: true });
    let real: string;
    try {
      real = await realpath(abs);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (real !== (await this.expectedReal(relDir)))
      throw new UnsafePathError(`${relDir} contains a symbolic link`);
    if (!(await lstat(real)).isDirectory()) throw new UnsafePathError(`${relDir} is not a directory`);
    return real;
  }

  /** Opens a stored file for reading through a verified descriptor; null when it is not there. */
  async openFile(relPath: string): Promise<OpenedFile | null> {
    try {
      return await openVerifiedFile(this.resolve(relPath), await this.expectedReal(relPath));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** True when the stored file is there, a regular file, reached without links. */
  async hasFile(relPath: string): Promise<boolean> {
    const opened = await this.openFile(relPath).catch(() => null);
    await opened?.handle.close().catch(() => undefined);
    return opened !== null;
  }

  /**
   * Removes the entry `relPath` (a file, or a link planted in its place; never what a link points
   * to) from its verified directory. True when something was removed.
   */
  async unlinkFile(relPath: string): Promise<boolean> {
    const dir = await this.realDir(path.dirname(path.relative(this.root, this.resolve(relPath))));
    if (!dir) return false;
    try {
      await unlink(path.join(dir, path.basename(relPath)));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /** Removes directory `relDir` and everything in it; rm never follows links inside it. */
  async removeTree(relDir: string): Promise<void> {
    const abs = this.resolve(relDir);
    if (!(await this.rootIsRealDir())) return;
    const real = path.join(await this.expectedReal(), path.relative(this.root, abs));
    await rm(real, { recursive: true, force: true });
  }
}
