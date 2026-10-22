/**
 * The view of a project's `.git` that core's git transport (isomorphic-git) works through. Agents
 * run as the same user as core and can change `.git` at any moment, so:
 * - the project folder must be `realpath(workspacesDir)/<its path>` (no link on the way) and `.git`
 *   a plain directory; every path is checked to stay inside `.git`, and every component is
 *   lstat-ed: a symbolic link anywhere is refused, never followed;
 * - reads go through a verified descriptor (`openVerifiedFile`: O_NOFOLLOW, `/proc/self/fd` must
 *   name the expected path), with a size cap;
 * - `.git/config` is never read: the operation's own config is served instead (no pushurl,
 *   insteadOf, proxy, corsProxy, helpers, askPass or submodules can take effect);
 * - writes are limited to loose objects, packs (object count capped) and the refs the operation
 *   updates; each is written to an O_EXCL|O_NOFOLLOW temp file in a verified directory and renamed
 *   into place (rename never follows the final component); deletes, links and chmod are refused;
 * - every refusal is recorded, because isomorphic-git turns some errors into "missing": the
 *   transport calls `assertClean()` after each step and fails the operation.
 *
 * The remaining race, as in outputs/safe-fs.ts: Node has no mkdirat/renameat, so a directory
 * created or a temp file renamed into place is addressed by path right after its directory was
 * verified. An agent that swaps that directory for a link inside that window can make core create
 * an empty directory, or place a loose object, a pack or a ref file (content from the remote or a
 * commit id), inside the link's target. Reads are not affected.
 */
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PromiseFsClient } from 'isomorphic-git';
import {
  createExclusiveFile,
  isMissing,
  openVerifiedFile,
  realDirUnder,
  UnsafePathError,
} from '../outputs/safe-fs.js';
import { GitTransportError } from './http.js';

const MB = 1024 * 1024;
const PACK_FILE = /^objects\/pack\/pack-[0-9a-f]{40}\.(?:pack|idx)$/;
const LOOSE_OBJECT = /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/;
const OBJECT_DIR = /^objects(?:\/pack|\/[0-9a-f]{2})?$/;
const REF_SEGMENT = /^(?![.-])(?!.*\.lock$)[A-Za-z0-9._@+-]+$/;
const MAX_TREE_ENTRIES = 200_000;

/** A ref Emberline may name or write: under refs/, plain segments, no `..`, `@{`, leading dot or dash, or `.lock`. */
export function isSafeRefPath(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    ref.split('/').every((s) => REF_SEGMENT.test(s))
  );
}

export interface RepoFsOptions {
  /** The base core trusts (config.workspacesDir). */
  workspacesDir: string;
  /** The repository's working directory (projects.path, or a new import target). */
  repoRoot: string;
  /** Served for `.git/config`. */
  config: string;
  /** Refs this operation may write, relative to `.git`. */
  refs: string[];
  /** ...or below these prefixes (each ends in `/`): the import clone's `refs/remotes/origin/`, `refs/tags/`. */
  refPrefixes?: string[];
  maxReadBytes?: number;
  maxPackObjects?: number;
}

type Code = 'ENOENT' | 'EACCES';
const fsError = (code: string, message: string) => Object.assign(new Error(message), { code });

export class RepoFs {
  /** Every refusal, including those isomorphic-git swallows. */
  readonly violations: string[] = [];
  readonly client: PromiseFsClient;
  private failure: GitTransportError | null = null;
  private readonly maxReadBytes: number;
  private readonly maxPackObjects: number;

  private constructor(
    readonly gitdir: string,
    private readonly options: RepoFsOptions,
  ) {
    this.maxReadBytes = options.maxReadBytes ?? 1024 * MB;
    this.maxPackObjects = options.maxPackObjects ?? 5_000_000;
    this.client = {
      promises: {
        readFile: this.readFile,
        writeFile: this.writeFile,
        unlink: this.unlink,
        readdir: this.readdirAt,
        mkdir: this.mkdirAt,
        rmdir: this.denied('rmdir'),
        stat: this.lstatAt,
        lstat: this.lstatAt,
        readlink: this.denied('readlink'),
        symlink: this.denied('symlink', 1),
        chmod: this.denied('chmod'),
      },
    };
  }

  static async open(options: RepoFsOptions): Promise<RepoFs> {
    let root: string | null;
    try {
      root = await realDirUnder(options.workspacesDir, options.repoRoot);
    } catch (error) {
      if (error instanceof UnsafePathError) {
        throw new GitTransportError(
          'unsafe_repo',
          'The project folder is reached through a symbolic link or lies outside the workspaces; Emberline does not follow it.',
        );
      }
      throw error;
    }
    if (!root) throw new GitTransportError('not_found', 'The project folder does not exist.');
    const gitdir = path.join(root, '.git');
    const st = await lstat(gitdir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      throw new GitTransportError(
        'unsafe_repo',
        "The project's .git is a symbolic link or a file, not a directory; Emberline's git transport needs a plain repository.",
      );
    }
    return new RepoFs(gitdir, options);
  }

  /** Before any request: no link on the given paths, in objects/ (two levels), objects/pack/ or anywhere under refs/; no shallow file. */
  async preflight(paths: string[]): Promise<void> {
    try {
      for (const rel of [
        'HEAD',
        'config',
        'packed-refs',
        'objects',
        'objects/pack',
        'objects/info',
        'refs',
        ...paths,
      ])
        await this.walk(rel, 'ENOENT');
      await this.walkTree('objects', 2, { count: 0 });
      await this.walkTree('refs', 64, { count: 0 });
      if (await this.walk('shallow', 'ENOENT')) {
        throw new GitTransportError(
          'unsupported',
          'This repository is a shallow clone; Emberline fetches and pushes only full repositories. Run "git fetch --unshallow" in a terminal first.',
        );
      }
    } catch (error) {
      this.assertClean();
      throw error;
    }
    this.assertClean();
  }

  /** Fails the operation for any refusal or cap that was hit, also one isomorphic-git swallowed. */
  assertClean(): void {
    if (this.violations.length > 0) {
      throw new GitTransportError(
        'unsafe_repo',
        `Refused ${this.violations[0]}. Emberline follows no symbolic links in .git and writes only the objects and refs it updates.`,
      );
    }
    if (this.failure) throw this.failure;
  }

  private refuse(rel: string, what: string, code: Code): never {
    const text = `${what} at .git/${rel}`.replace(/\/$/, '');
    this.violations.push(text);
    throw fsError(code, text);
  }

  private fail(error: GitTransportError): never {
    this.failure ??= error;
    throw fsError('EFBIG', error.message);
  }

  /** `.git`-relative POSIX path of a path isomorphic-git passes; anything outside `.git` is refused. */
  private rel(p: string, code: Code): string {
    const rel = path.relative(this.gitdir, path.resolve(p));
    if (rel === '') return '';
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      this.violations.push('a path outside .git');
      throw fsError(code, 'a path outside .git');
    }
    return rel.split(path.sep).join('/');
  }

  /** lstat of `.git` and every component of `rel`: a link is refused; null when missing. */
  private async walk(rel: string, code: Code): Promise<Stats | null> {
    let st = await lstat(this.gitdir);
    if (st.isSymbolicLink() || !st.isDirectory()) this.refuse('', 'a symbolic link', code);
    const parts = rel === '' ? [] : rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const sub = parts.slice(0, i + 1).join('/');
      try {
        st = await lstat(path.join(this.gitdir, sub));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (st.isSymbolicLink()) this.refuse(sub, 'a symbolic link', code);
      if (i < parts.length - 1 && !st.isDirectory()) return null;
    }
    return st;
  }

  private async walkTree(rel: string, depth: number, seen: { count: number }): Promise<void> {
    const st = await this.walk(rel, 'ENOENT');
    if (!st?.isDirectory() || depth === 0) return;
    for (const name of await readdir(await this.verifiedDir(rel, 'ENOENT'))) {
      if (++seen.count > MAX_TREE_ENTRIES) {
        throw new GitTransportError(
          'too_large',
          `.git/${rel} has more than ${MAX_TREE_ENTRIES} entries; Emberline's git transport stops there.`,
        );
      }
      await this.walkTree(`${rel}/${name}`, depth - 1, seen);
    }
  }

  /** The real path of a `.git` directory, which must be exactly `.git/<rel>`. */
  private async verifiedDir(rel: string, code: Code): Promise<string> {
    const abs = rel === '' || rel === '.' ? this.gitdir : path.join(this.gitdir, rel);
    try {
      const real = await realDirUnder(this.gitdir, abs);
      if (!real) throw fsError('ENOENT', `no directory .git/${rel}`);
      return real;
    } catch (error) {
      if (error instanceof UnsafePathError) this.refuse(rel, 'a path that resolves elsewhere', code);
      throw error;
    }
  }

  private mayWrite(rel: string): boolean {
    if (PACK_FILE.test(rel) || LOOSE_OBJECT.test(rel)) return true;
    if (!isSafeRefPath(rel)) return false;
    return (
      this.options.refs.includes(rel) ||
      (this.options.refPrefixes ?? []).some((prefix) => rel.startsWith(prefix) && rel.length > prefix.length)
    );
  }

  private mayCreateDir(rel: string): boolean {
    if (OBJECT_DIR.test(rel) || rel === 'refs') return true;
    if (!isSafeRefPath(rel)) return false;
    const prefixes = this.options.refPrefixes ?? [];
    return (
      [...this.options.refs, ...prefixes].some((t) => t.startsWith(`${rel}/`)) ||
      prefixes.some((prefix) => `${rel}/`.startsWith(prefix))
    );
  }

  private checkPack(bytes: Buffer): void {
    if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'PACK') {
      this.fail(new GitTransportError('protocol', 'The server sent something that is not a git pack.'));
    }
    const count = bytes.readUInt32BE(8);
    if (count > this.maxPackObjects) {
      this.fail(
        new GitTransportError(
          'too_large',
          `The server's pack has ${count} objects, more than Emberline's limit of ${this.maxPackObjects}.`,
        ),
      );
    }
  }

  private readonly readFile = async (p: unknown, opts?: unknown): Promise<Buffer | string> => {
    // isomorphic-git probes with readFile() and no path to see whether this fs returns promises.
    if (typeof p !== 'string') throw fsError('EINVAL', 'no path');
    const rel = this.rel(p, 'ENOENT');
    const encoding = (
      typeof opts === 'string' ? opts : (opts as { encoding?: string } | undefined)?.encoding
    ) as BufferEncoding | undefined;
    if (rel === 'config') {
      await this.walk('config', 'ENOENT');
      return encoding ? this.options.config : Buffer.from(this.options.config);
    }
    const st = await this.walk(rel, 'ENOENT');
    if (!st?.isFile()) throw fsError('ENOENT', `no file at .git/${rel}`);
    const abs = path.join(this.gitdir, rel);
    let opened;
    try {
      opened = await openVerifiedFile(abs, abs);
    } catch (error) {
      if (error instanceof UnsafePathError) this.refuse(rel, 'a path that resolves elsewhere', 'ENOENT');
      throw error;
    }
    try {
      if (opened.size > this.maxReadBytes) {
        this.fail(
          new GitTransportError(
            'too_large',
            `.git/${rel} is larger than ${Math.round(this.maxReadBytes / MB)} MB; Emberline's git transport stops there.`,
          ),
        );
      }
      const data = Buffer.alloc(opened.size);
      let pos = 0;
      while (pos < data.length) {
        const { bytesRead } = await opened.handle.read(data, pos, data.length - pos, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
      }
      const bytes = data.subarray(0, pos);
      return encoding ? bytes.toString(encoding) : bytes;
    } finally {
      await opened.handle.close();
    }
  };

  private readonly writeFile = async (p: unknown, data: unknown): Promise<void> => {
    if (typeof p !== 'string') throw fsError('EINVAL', 'no path');
    const rel = this.rel(p, 'EACCES');
    if (!this.mayWrite(rel)) this.refuse(rel, 'a write outside what this operation updates', 'EACCES');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data as Uint8Array);
    if (rel.endsWith('.pack')) this.checkPack(bytes);
    const dir = path.posix.dirname(rel);
    const parent = await this.walk(dir, 'EACCES');
    // Missing: isomorphic-git creates the directory and writes again.
    if (!parent?.isDirectory()) throw fsError('ENOENT', `no directory .git/${dir}`);
    const realDir = await this.verifiedDir(dir, 'EACCES');
    const name = path.posix.basename(rel);
    const existing = await lstat(path.join(realDir, name)).catch(() => null);
    if (existing && !existing.isFile())
      this.refuse(
        rel,
        existing.isSymbolicLink() ? 'a symbolic link' : 'something that is not a file',
        'EACCES',
      );
    const tmp = `.emberline-${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await createExclusiveFile(realDir, tmp);
    } catch (error) {
      if (error instanceof UnsafePathError)
        this.refuse(rel, 'a directory swapped while it was written', 'EACCES');
      throw error;
    }
    try {
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      await rename(path.join(realDir, tmp), path.join(realDir, name));
    } catch (error) {
      // Ours (unique name, created with O_EXCL): never left behind in .git.
      await unlink(path.join(realDir, tmp)).catch(() => undefined);
      throw error;
    }
  };

  private readonly mkdirAt = async (p: unknown): Promise<void> => {
    if (typeof p !== 'string') throw fsError('EINVAL', 'no path');
    const rel = this.rel(p, 'EACCES');
    if (rel === '' || (await this.walk(rel, 'EACCES'))) throw fsError('EEXIST', `.git/${rel} exists`);
    if (!this.mayCreateDir(rel))
      this.refuse(rel, 'a directory outside what this operation updates', 'EACCES');
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const parent = await this.walk(dir, 'EACCES');
    if (!parent?.isDirectory()) throw fsError('ENOENT', `no directory .git/${dir}`);
    await mkdir(path.join(await this.verifiedDir(dir, 'EACCES'), path.posix.basename(rel)), { mode: 0o755 });
    if (!(await this.walk(rel, 'EACCES'))?.isDirectory())
      this.refuse(rel, 'a directory that changed while it was made', 'EACCES');
  };

  private readonly unlink = async (p: unknown): Promise<void> => {
    if (typeof p !== 'string') throw fsError('EINVAL', 'no path');
    const rel = this.rel(p, 'EACCES');
    // isomorphic-git removes `shallow` when the server sends none: nothing to do when there is none.
    if (!(await this.walk(rel, 'EACCES'))) throw fsError('ENOENT', `no file at .git/${rel}`);
    this.refuse(rel, 'a delete', 'EACCES');
  };

  private readonly readdirAt = async (p: unknown): Promise<string[]> => {
    if (typeof p !== 'string') throw fsError('EINVAL', 'no path');
    const rel = this.rel(p, 'ENOENT');
    const st = await this.walk(rel, 'ENOENT');
    if (!st) throw fsError('ENOENT', `no directory .git/${rel}`);
    if (!st.isDirectory()) throw fsError('ENOTDIR', `.git/${rel} is not a directory`);
    return readdir(await this.verifiedDir(rel, 'ENOENT'));
  };

  private readonly lstatAt = async (p: unknown): Promise<Stats> => {
    if (typeof p !== 'string') throw fsError('EINVAL', 'no path');
    const st = await this.walk(this.rel(p, 'ENOENT'), 'ENOENT');
    if (!st) throw fsError('ENOENT', 'missing');
    return st;
  };

  /** rmdir, readlink, symlink, chmod: never needed for fetch and push. */
  private denied(what: string, pathArg = 0) {
    return async (...args: unknown[]): Promise<never> => {
      const p = args[pathArg];
      this.refuse(typeof p === 'string' ? this.rel(p, 'EACCES') : '?', `a ${what}`, 'EACCES');
    };
  }
}
