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

export interface OpenTab {
  path: string;
  content: string;
  savedContent: string;
  loading: boolean;
  binary: boolean;
  sizeBytes: number;
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

function getFileExtension(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx).toLowerCase() : '';
}

export function FileTypeIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="icon" aria-hidden />;
}

export function describeFileType(filePath: string): {
  icon: LucideIcon;
  label: string;
  previewKind: 'image' | 'audio' | 'video' | 'none';
} {
  const ext = getFileExtension(filePath);
  switch (ext) {
    case '.apk':
    case '.aab':
    case '.ipa':
      return {
        icon: Package,
        label: `Mobile Application Package (${ext})`,
        previewKind: 'none',
      };
    case '.zip':
    case '.tar':
    case '.gz':
    case '.tgz':
    case '.bz2':
    case '.xz':
    case '.7z':
    case '.rar':
    case '.jar':
    case '.war':
      return {
        icon: FileArchive,
        label: `Compressed Archive / Package (${ext})`,
        previewKind: 'none',
      };
    case '.bin':
    case '.elf':
    case '.uf2':
    case '.hex':
    case '.img':
    case '.iso':
    case '.exe':
    case '.dll':
    case '.so':
    case '.dylib':
    case '.wasm':
    case '.class':
    case '.dex':
      return {
        icon: Settings,
        label: `Compiled Binary / Firmware Artifact (${ext})`,
        previewKind: 'none',
      };
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.svg':
    case '.ico':
    case '.bmp':
    case '.avif':
      return {
        icon: ImageIcon,
        label: `Image Asset (${ext})`,
        previewKind: 'image',
      };
    case '.mp3':
    case '.wav':
    case '.ogg':
    case '.flac':
    case '.m4a':
    case '.aac':
      return {
        icon: Volume2,
        label: `Audio Asset (${ext})`,
        previewKind: 'audio',
      };
    case '.mp4':
    case '.webm':
    case '.mov':
      return {
        icon: Clapperboard,
        label: `Video Asset (${ext})`,
        previewKind: 'video',
      };
    case '.pdf':
      return {
        icon: Book,
        label: 'PDF Document (.pdf)',
        previewKind: 'none',
      };
    case '.sqlite':
    case '.sqlite3':
    case '.db':
      return {
        icon: Database,
        label: `Database File (${ext})`,
        previewKind: 'none',
      };
    case '.woff':
    case '.woff2':
    case '.ttf':
    case '.otf':
    case '.eot':
      return {
        icon: Type,
        label: `Font Asset (${ext})`,
        previewKind: 'none',
      };
    case '.keystore':
    case '.jks':
    case '.p12':
    case '.pfx':
      return {
        icon: KeyRound,
        label: `Cryptographic Keystore (${ext})`,
        previewKind: 'none',
      };
    default:
      return {
        icon: FileText,
        label: ext ? `Workspace File (${ext})` : 'Workspace File',
        previewKind: 'none',
      };
  }
}

export function getFileDownloadUrl(
  projectId: string,
  targetId: string,
  relPath: string,
  inline = false,
): string {
  const params = new URLSearchParams({
    targetId,
    path: relPath,
  });
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

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'html':
    case 'htm':
    case 'svg':
      return 'html';
    case 'xml':
    case 'plist':
    case 'manifest':
      return 'xml';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'ino':
      return 'cpp';
    case 'java':
    case 'gradle':
      return 'java';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'swift':
      return 'swift';
    case 'cs':
      return 'csharp';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'toml':
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'env':
      return 'ini';
    case 'sql':
      return 'sql';
    case 'dockerfile':
      return 'dockerfile';
    default:
      return 'plaintext';
  }
}
