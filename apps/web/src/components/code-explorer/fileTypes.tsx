import type { Project, Run, WorkspaceFileEntry } from '@emberline/protocol';
import {
  Book,
  Clapperboard,
  Database,
  FileArchive,
  FileText,
  Image as ImageIcon,
  KeyRound,
  type LucideIcon,
  Package,
  Settings,
  Type,
  Volume2,
} from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';

export interface OpenTab {
  path: string;
  content: string;
  savedContent: string;
  loading: boolean;
  binary: boolean;
  sizeBytes: number;
  error?: string;
}

export interface ExplorerCtx {
  pid: string;
  fbase: string;
  proj: Project | undefined;
  tid: string;
  setTid: (next: string) => void;
  runs: Run[];
  wsPath: string | undefined;
  entries: WorkspaceFileEntry[] | undefined;
  tabs: OpenTab[];
  active: string | null;
  tab: OpenTab | null;
  saving: boolean;
  err: string | null;
  setErr: (v: string | null) => void;
  msg: string | null;
  setMsg: (v: string | null) => void;
  refresh: () => Promise<void>;
  open: (relPath: string) => Promise<void>;
  del: (relPath: string) => Promise<void>;
  uploaded: (paths: string[]) => Promise<void>;
  selTab: (path: string) => void;
  closeTab: (path: string, e: MouseEvent) => void;
  editTab: (path: string, nextContent: string) => void;
  save: () => Promise<void>;
}

export const CE_TREE_BTN: CSSProperties = { padding: '2px 6px', fontSize: '0.72rem' };
export const CE_CENTER: CSSProperties = {
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export interface FileTypeDescriptor {
  icon: LucideIcon;
  label: string;
  previewKind: 'image' | 'audio' | 'video' | 'none';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function getFileExtension(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx).toLowerCase() : '';
}

const FILE_TYPE_GROUPS: ReadonlyArray<{
  exts: string;
  icon: LucideIcon;
  prefix: string;
  previewKind: FileTypeDescriptor['previewKind'];
  fixedLabel?: string;
}> = [
  { exts: '.apk,.aab,.ipa', icon: Package, prefix: 'Mobile Application Package', previewKind: 'none' },
  {
    exts: '.zip,.tar,.gz,.tgz,.bz2,.xz,.7z,.rar,.jar,.war',
    icon: FileArchive,
    prefix: 'Compressed Archive / Package',
    previewKind: 'none',
  },
  {
    exts: '.bin,.elf,.uf2,.hex,.img,.iso,.exe,.dll,.so,.dylib,.wasm,.class,.dex',
    icon: Settings,
    prefix: 'Compiled Binary / Firmware Artifact',
    previewKind: 'none',
  },
  {
    exts: '.png,.jpg,.jpeg,.gif,.webp,.svg,.ico,.bmp,.avif',
    icon: ImageIcon,
    prefix: 'Image Asset',
    previewKind: 'image',
  },
  { exts: '.mp3,.wav,.ogg,.flac,.m4a,.aac', icon: Volume2, prefix: 'Audio Asset', previewKind: 'audio' },
  { exts: '.mp4,.webm,.mov', icon: Clapperboard, prefix: 'Video Asset', previewKind: 'video' },
  {
    exts: '.pdf',
    icon: Book,
    prefix: 'PDF Document',
    previewKind: 'none',
    fixedLabel: 'PDF Document (.pdf)',
  },
  { exts: '.sqlite,.sqlite3,.db', icon: Database, prefix: 'Database File', previewKind: 'none' },
  { exts: '.woff,.woff2,.ttf,.otf,.eot', icon: Type, prefix: 'Font Asset', previewKind: 'none' },
  { exts: '.keystore,.jks,.p12,.pfx', icon: KeyRound, prefix: 'Cryptographic Keystore', previewKind: 'none' },
];

export function describeFileType(filePath: string): FileTypeDescriptor {
  const ext = getFileExtension(filePath);
  if (ext) {
    for (const group of FILE_TYPE_GROUPS) {
      if (group.exts.split(',').includes(ext)) {
        return {
          icon: group.icon,
          label: group.fixedLabel ?? `${group.prefix} (${ext})`,
          previewKind: group.previewKind,
        };
      }
    }
  }
  return {
    icon: FileText,
    label: ext ? `Workspace File (${ext})` : 'Workspace File',
    previewKind: 'none',
  };
}

export function getFileDownloadUrl(
  projectId: string,
  targetId: string,
  relPath: string,
  inline = false,
): string {
  const params = new URLSearchParams({ targetId, path: relPath });
  if (inline) params.set('inline', '1');
  return `/api/projects/${encodeURIComponent(projectId)}/files/download?${params.toString()}`;
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? (result.split(',')[1] ?? '') : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
    reader.readAsDataURL(file);
  });
}

const LANG_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['ts,tsx', 'typescript'],
  ['js,jsx,mjs,cjs', 'javascript'],
  ['css,scss,less', 'css'],
  ['html,htm,svg', 'html'],
  ['xml,plist,manifest', 'xml'],
  ['md,markdown', 'markdown'],
  ['c,h', 'c'],
  ['cpp,cc,cxx,hpp,ino', 'cpp'],
  ['java,gradle', 'java'],
  ['kt,kts', 'kotlin'],
  ['sh,bash,zsh', 'shell'],
  ['yml,yaml', 'yaml'],
  ['toml,ini,cfg,conf,env', 'ini'],
  ['json', 'json'],
  ['py', 'python'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['swift', 'swift'],
  ['cs', 'csharp'],
  ['sql', 'sql'],
  ['dockerfile', 'dockerfile'],
];

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = Object.fromEntries(
  LANG_GROUPS.flatMap(([exts, lang]) => exts.split(',').map((ext) => [ext, lang])),
);

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}
