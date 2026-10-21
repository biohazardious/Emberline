/** Code explorer: symlink-safe listing, reading, uploading, editing and deleting workspace files. */
import { constants as fsConstants, existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ADOPT_FILE_PATHS,
  type UploadWorkspaceFileItem,
  type UploadWorkspaceFilesResponse,
  type WorkspaceFileContentResponse,
  type WorkspaceFileEntry,
} from '@emberline/protocol';

// --- F8: VS Code-like Code Explorer & File Editor ---------------------------

const EXPLORER_IGNORED = new Set([
  '.git',
  'node_modules',
  '.emberline',
  '.turbo',
  '.next',
  'coverage',
  '.gradle',
  'intermediates',
  '__pycache__',
  '.venv',
  '.pytest_cache',
  '.mypy_cache',
  '.cache',
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.apk',
  '.aab',
  '.ipa',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.elf',
  '.uf2',
  '.hex',
  '.img',
  '.iso',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.war',
  '.class',
  '.dex',
  '.wasm',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.avif',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
  '.aac',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.keystore',
  '.jks',
  '.p12',
  '.pfx',
  '.pyc',
  '.pyo',
  '.o',
  '.a',
  '.lib',
]);

const DOWNLOAD_MIME_BY_EXT: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.ipa': 'application/octet-stream',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function resolveSafeWorkspaceFile(workspacePath: string, relPath: string): string {
  const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanRel) throw new Error('File path cannot be empty');
  const absRoot = path.resolve(workspacePath);
  const resolved = path.resolve(absRoot, cleanRel);
  if (!resolved.startsWith(absRoot + path.sep)) {
    throw new Error('Path traversal outside workspace is forbidden');
  }
  return resolved;
}

const isInside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);

/**
 * `resolveSafeWorkspaceFile` plus symlink checks. Agents control the workspace, so a planted link
 * (`README.md -> /data/emberline.db`, `src -> /opt`) must never let the explorer read or write
 * outside it. The nearest existing ancestor must resolve inside the workspace and, unless
 * `allowLinkTarget` (delete removes the link itself), the file must not be a symlink.
 */
async function resolveContainedWorkspaceFile(
  workspacePath: string,
  relPath: string,
  { allowLinkTarget = false }: { allowLinkTarget?: boolean } = {},
): Promise<string> {
  const resolved = resolveSafeWorkspaceFile(workspacePath, relPath);
  const realRoot = await realpath(path.resolve(workspacePath));
  let ancestor = path.dirname(resolved);
  while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  if (!isInside(realRoot, await realpath(ancestor))) {
    throw new Error('Path resolves outside the workspace through a symlink');
  }
  const entry = await lstat(resolved).catch(() => null);
  if (entry?.isSymbolicLink() && !allowLinkTarget) {
    throw new Error(`Refusing to follow symlink: ${relPath}`);
  }
  return resolved;
}

/** Creates or truncates without following a symlink swapped in after the containment check. */
const WRITE_NO_FOLLOW = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;

/**
 * The one file the explorer shows under `.emberline` (scratch files stay hidden): the folder and
 * `worktree.yml` when that is a regular file, nothing otherwise (a link is never listed).
 */
async function worktreeYmlEntries(absRoot: string): Promise<WorkspaceFileEntry[]> {
  const dirRel = path.dirname(ADOPT_FILE_PATHS.worktreeYml);
  try {
    const [dirStat, fileStat] = await Promise.all([
      lstat(path.join(absRoot, dirRel)),
      lstat(path.join(absRoot, ADOPT_FILE_PATHS.worktreeYml)),
    ]);
    if (!dirStat.isDirectory() || !fileStat.isFile()) return [];
    return [
      { path: dirRel, name: dirRel, kind: 'directory', sizeBytes: 0, mtime: dirStat.mtime.toISOString() },
      {
        path: ADOPT_FILE_PATHS.worktreeYml,
        name: path.basename(ADOPT_FILE_PATHS.worktreeYml),
        kind: 'file',
        sizeBytes: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
      },
    ];
  } catch {
    return [];
  }
}

export async function listWorkspaceFilesFlat(workspacePath: string): Promise<WorkspaceFileEntry[]> {
  if (!existsSync(workspacePath)) return [];
  const entries: WorkspaceFileEntry[] = [];
  const absRoot = path.resolve(workspacePath);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 10 || entries.length >= 2500) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (dir === absRoot && item.name === '.emberline' && item.isDirectory()) {
        entries.push(...(await worktreeYmlEntries(absRoot)));
        continue;
      }
      if (EXPLORER_IGNORED.has(item.name)) continue;
      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(absRoot, fullPath);
      try {
        const st = await stat(fullPath);
        if (item.isDirectory()) {
          entries.push({
            path: relPath,
            name: item.name,
            kind: 'directory',
            sizeBytes: 0,
            mtime: st.mtime.toISOString(),
          });
          await walk(fullPath, depth + 1);
        } else if (item.isFile()) {
          entries.push({
            path: relPath,
            name: item.name,
            kind: 'file',
            sizeBytes: st.size,
            mtime: st.mtime.toISOString(),
          });
        }
      } catch {
        // ignore broken symlink
      }
      if (entries.length >= 2500) return;
    }
  }

  await walk(absRoot, 0);
  return entries;
}

export async function readWorkspaceFileContent(
  workspacePath: string,
  targetId: string,
  relPath: string,
): Promise<WorkspaceFileContentResponse> {
  const absFile = await resolveContainedWorkspaceFile(workspacePath, relPath);
  if (!existsSync(absFile)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const st = await stat(absFile);
  if (st.isDirectory()) {
    throw new Error(`Cannot read directory as file: ${relPath}`);
  }
  const ext = path.extname(absFile).toLowerCase();
  if (KNOWN_BINARY_EXTENSIONS.has(ext) || st.size > 2 * 1024 * 1024) {
    return {
      targetId,
      path: relPath,
      content: '',
      binary: true,
      sizeBytes: st.size,
    };
  }
  const buf = await readFile(absFile);
  const sample = buf.subarray(0, 8192);
  const binary = sample.includes(0);
  return {
    targetId,
    path: relPath,
    content: binary ? '' : buf.toString('utf-8'),
    binary,
    sizeBytes: st.size,
  };
}

export async function readWorkspaceFileRaw(
  workspacePath: string,
  relPath: string,
): Promise<{
  absFile: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  buffer: Buffer;
}> {
  const absFile = await resolveContainedWorkspaceFile(workspacePath, relPath);
  if (!existsSync(absFile)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const st = await stat(absFile);
  if (st.isDirectory()) {
    throw new Error(`Cannot download a directory directly: ${relPath}`);
  }
  const ext = path.extname(absFile).toLowerCase();
  const contentType = DOWNLOAD_MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const buffer = await readFile(absFile);
  return {
    absFile,
    fileName: path.basename(absFile),
    contentType,
    sizeBytes: st.size,
    buffer,
  };
}

export async function uploadWorkspaceFiles(
  workspacePath: string,
  targetId: string,
  files: UploadWorkspaceFileItem[],
): Promise<UploadWorkspaceFilesResponse> {
  const uploadedPaths: string[] = [];
  for (const item of files) {
    const cleanRel = item.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const absFile = await resolveContainedWorkspaceFile(workspacePath, cleanRel);
    await mkdir(path.dirname(absFile), { recursive: true });
    const rawBase64 = item.dataBase64.includes(',')
      ? (item.dataBase64.split(',')[1] ?? '')
      : item.dataBase64;
    const buf = Buffer.from(rawBase64, 'base64');
    await writeFile(absFile, buf, { flag: WRITE_NO_FOLLOW });
    uploadedPaths.push(cleanRel);
  }
  return {
    targetId,
    uploadedPaths,
  };
}

export async function writeWorkspaceFileContent(
  workspacePath: string,
  targetId: string,
  relPath: string,
  content: string,
): Promise<WorkspaceFileContentResponse> {
  const absFile = await resolveContainedWorkspaceFile(workspacePath, relPath);
  await mkdir(path.dirname(absFile), { recursive: true });
  await writeFile(absFile, content, { encoding: 'utf-8', flag: WRITE_NO_FOLLOW });
  const st = await stat(absFile);
  return {
    targetId,
    path: relPath,
    content,
    binary: false,
    sizeBytes: st.size,
  };
}

export async function deleteWorkspaceFileEntry(workspacePath: string, relPath: string): Promise<void> {
  const absFile = await resolveContainedWorkspaceFile(workspacePath, relPath, { allowLinkTarget: true });
  await rm(absFile, { recursive: true, force: true });
}
