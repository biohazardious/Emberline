import type {
  AgentPersona,
  FactoryRequestResponse,
  Project,
  UploadWorkspaceFilesResponse,
  WorkspaceFileContentResponse,
  WorkspaceFileEntry,
  WorkspaceFileListResponse,
} from '@emberline/protocol';
import type * as Monaco from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../api';
import { PERSONA_BY_ID, PERSONA_LIST } from '../components/PersonaBadge';
import { usePoll } from '../hooks/usePoll';
import { useRuns } from '../hooks/useRuns';

interface OpenTab {
  path: string;
  content: string;
  savedContent: string;
  loading: boolean;
  binary: boolean;
  sizeBytes: number;
}

let monacoLoader: Promise<typeof Monaco> | null = null;
function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoLoader) {
    const globalScope = globalThis as unknown as {
      MonacoEnvironment?: { getWorker: () => Worker };
    };
    if (!globalScope.MonacoEnvironment) {
      globalScope.MonacoEnvironment = {
        getWorker: () => {
          const blob = new Blob(['self.onmessage = function() {};'], {
            type: 'application/javascript',
          });
          return new Worker(URL.createObjectURL(blob));
        },
      };
    }
    monacoLoader = import('monaco-editor');
  }
  return monacoLoader;
}

function formatBytes(bytes: number): string {
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

function describeFileType(filePath: string): {
  icon: string;
  label: string;
  previewKind: 'image' | 'audio' | 'video' | 'none';
} {
  const ext = getFileExtension(filePath);
  switch (ext) {
    case '.apk':
    case '.aab':
    case '.ipa':
      return {
        icon: '📦',
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
        icon: '🗜️',
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
        icon: '⚙️',
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
        icon: '🖼️',
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
        icon: '🔊',
        label: `Audio Asset (${ext})`,
        previewKind: 'audio',
      };
    case '.mp4':
    case '.webm':
    case '.mov':
      return {
        icon: '🎬',
        label: `Video Asset (${ext})`,
        previewKind: 'video',
      };
    case '.pdf':
      return {
        icon: '📕',
        label: 'PDF Document (.pdf)',
        previewKind: 'none',
      };
    case '.sqlite':
    case '.sqlite3':
    case '.db':
      return {
        icon: '🗄️',
        label: `Database File (${ext})`,
        previewKind: 'none',
      };
    case '.woff':
    case '.woff2':
    case '.ttf':
    case '.otf':
    case '.eot':
      return {
        icon: '🔤',
        label: `Font Asset (${ext})`,
        previewKind: 'none',
      };
    case '.keystore':
    case '.jks':
    case '.p12':
    case '.pfx':
      return {
        icon: '🔑',
        label: `Cryptographic Keystore (${ext})`,
        previewKind: 'none',
      };
    default:
      return {
        icon: '📄',
        label: ext ? `Workspace File (${ext})` : 'Workspace File',
        previewKind: 'none',
      };
  }
}

function getFileDownloadUrl(
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

function readFileAsBase64(file: File): Promise<string> {
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

function detectLanguage(filePath: string): string {
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

function StandaloneMonacoEditor({
  filePath,
  language,
  value,
  theme,
  onChange,
}: {
  filePath: string;
  language: string;
  value: string;
  theme: 'vs-dark' | 'vs';
  onChange: (next: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    let model: Monaco.editor.ITextModel | null = null;
    let sub: Monaco.IDisposable | null = null;

    void loadMonaco().then((monaco) => {
      if (cancelled || !containerRef.current) return;
      model = monaco.editor.createModel(value, language);
      const editor = monaco.editor.create(containerRef.current, {
        model,
        theme,
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        scrollBeyondLastLine: false,
        wordWrap: 'on',
      });
      sub = editor.onDidChangeModelContent(() => {
        onChangeRef.current(editor.getValue());
      });
      editorRef.current = editor;
    });

    return () => {
      cancelled = true;
      sub?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      model?.dispose();
    };
  }, [filePath, language, theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

export function CodeExplorerPage({ projectId }: { projectId: string }) {
  const projects = usePoll(() => api<Project[]>('/api/projects'), 15_000);
  const { runs } = useRuns();
  const project = useMemo(
    () => (projects.data ?? []).find((p) => p.id === projectId),
    [projects.data, projectId],
  );
  const projectRuns = useMemo(
    () => (runs ?? []).filter((r) => r.projectId === projectId),
    [runs, projectId],
  );

  const [targetId, setTargetId] = useState<string>('main');
  const [filterText, setFilterText] = useState('');
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadTargetDir, setUploadTargetDir] = useState('');
  const [showUploadBox, setShowUploadBox] = useState(false);
  const [dragOverTree, setDragOverTree] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Create file modal state
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');

  // Quick Agent File Edit prompt state
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentPersona, setAgentPersona] = useState<AgentPersona>('coder');
  const [dispatchingAgent, setDispatchingAgent] = useState(false);

  const fileList = usePoll(
    () =>
      api<WorkspaceFileListResponse>(
        `/api/projects/${projectId}/files?targetId=${encodeURIComponent(targetId)}`,
      ),
    6_000,
  );

  useEffect(() => {
    void fileList.refresh();
  }, [projectId, targetId]);

  const openFile = useCallback(
    async (relPath: string) => {
      setError(null);
      setActivePath(relPath);
      const existing = tabs.find((t) => t.path === relPath);
      if (existing) return;

      setTabs((prev) => [
        ...prev,
        {
          path: relPath,
          content: '',
          savedContent: '',
          loading: true,
          binary: false,
          sizeBytes: 0,
        },
      ]);
      try {
        const res = await api<WorkspaceFileContentResponse>(
          `/api/projects/${projectId}/files/content?targetId=${encodeURIComponent(targetId)}&path=${encodeURIComponent(relPath)}`,
        );
        setTabs((prev) =>
          prev.map((t) =>
            t.path === relPath
              ? {
                  ...t,
                  content: res.content,
                  savedContent: res.content,
                  loading: false,
                  binary: res.binary,
                  sizeBytes: res.sizeBytes,
                }
              : t,
          ),
        );
      } catch (err) {
        setError((err as Error).message);
        setTabs((prev) => prev.filter((t) => t.path !== relPath));
      }
    },
    [projectId, targetId, tabs],
  );

  // Auto-open index.html or PROJECT.md or first file on initial load
  useEffect(() => {
    if (tabs.length > 0 || activePath) return;
    const files = (fileList.data?.entries ?? []).filter(
      (f: WorkspaceFileEntry) => f.kind === 'file',
    );
    if (files.length === 0) return;
    const preferred =
      files.find((f: WorkspaceFileEntry) => f.path === 'PROJECT.md') ??
      files.find((f: WorkspaceFileEntry) => f.path === 'README.md') ??
      files.find(
        (f: WorkspaceFileEntry) =>
          f.path === 'src/App.tsx' || f.path === 'src/main.ts' || f.path === 'src/index.ts',
      ) ??
      files.find((f: WorkspaceFileEntry) => f.path === 'index.html') ??
      files[0];
    if (preferred) {
      void openFile(preferred.path);
    }
  }, [fileList.data, tabs.length, activePath, openFile]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activePath) ?? null,
    [tabs, activePath],
  );

  const saveActiveFile = useCallback(async () => {
    if (!activeTab || activeTab.binary) return;
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await api<WorkspaceFileContentResponse>(
        `/api/projects/${projectId}/files/content`,
        'PUT',
        {
          targetId,
          path: activeTab.path,
          content: activeTab.content,
        },
      );
      setTabs((prev) =>
        prev.map((t) =>
          t.path === activeTab.path
            ? { ...t, savedContent: res.content, sizeBytes: res.sizeBytes }
            : t,
        ),
      );
      setStatusMessage(`Saved ${activeTab.path}`);
      await fileList.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [activeTab, projectId, targetId, fileList]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveActiveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveActiveFile]);

  const handleUploadFiles = useCallback(
    async (fileItems: FileList | File[]) => {
      const list = Array.from(fileItems);
      if (list.length === 0) return;
      setUploading(true);
      setError(null);
      setStatusMessage(null);
      try {
        const cleanPrefix = uploadTargetDir
          .trim()
          .replace(/\\/g, '/')
          .replace(/^\/+|\/+$/g, '');
        const payloadFiles = await Promise.all(
          list.map(async (file) => {
            const dataBase64 = await readFileAsBase64(file);
            const relName = file.name.replace(/\\/g, '/').replace(/^\/+/, '');
            const targetPath = cleanPrefix ? `${cleanPrefix}/${relName}` : relName;
            return {
              path: targetPath,
              dataBase64,
            };
          }),
        );
        const res = await api<UploadWorkspaceFilesResponse>(
          `/api/projects/${projectId}/files/upload`,
          'POST',
          {
            targetId,
            files: payloadFiles,
          },
        );
        setStatusMessage(
          `Uploaded ${res.uploadedPaths.length} file(s): ${res.uploadedPaths.join(', ')}`,
        );
        setShowUploadBox(false);
        await fileList.refresh();
        const firstUploaded = res.uploadedPaths[0];
        if (firstUploaded) {
          setTabs((prev) => prev.filter((t) => !res.uploadedPaths.includes(t.path)));
          await openFile(firstUploaded);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [projectId, targetId, uploadTargetDir, fileList, openFile],
  );

  const handleCreateFile = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = newFilePath.trim().replace(/^\/+/, '');
    if (!cleaned) return;
    setError(null);
    try {
      await api<WorkspaceFileContentResponse>(
        `/api/projects/${projectId}/files/content`,
        'PUT',
        {
          targetId,
          path: cleaned,
          content: '',
        },
      );
      setNewFilePath('');
      setCreatingFile(false);
      await fileList.refresh();
      await openFile(cleaned);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDeleteFile = async (relPath: string) => {
    if (!window.confirm(`Delete "${relPath}" from workspace?`)) return;
    setError(null);
    try {
      await api(`/api/projects/${projectId}/files`, 'DELETE', {
        targetId,
        path: relPath,
      });
      setTabs((prev) => prev.filter((t) => t.path !== relPath));
      if (activePath === relPath) {
        const remaining = tabs.filter((t) => t.path !== relPath);
        setActivePath(remaining[0]?.path ?? null);
      }
      await fileList.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAskAgentOnFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentPrompt.trim() || !activeTab) return;
    setDispatchingAgent(true);
    setError(null);
    setStatusMessage(null);
    try {
      const contextualPrompt = `Target File: \`${activeTab.path}\`\n\nTask: ${agentPrompt.trim()}`;
      const res = await api<FactoryRequestResponse>(
        `/api/projects/${projectId}/factory-request`,
        'POST',
        {
          prompt: contextualPrompt,
          leadPersona: agentPersona,
          permissionMode: 'auto',
          autoDispatch: true,
        },
      );
      setAgentPrompt('');
      setStatusMessage(
        `Dispatched ${res.ticket.key} (${PERSONA_BY_ID[agentPersona].label}) for ${activeTab.path}`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDispatchingAgent(false);
    }
  };

  const closeTab = (pathToClose: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextTabs = tabs.filter((t) => t.path !== pathToClose);
    setTabs(nextTabs);
    if (activePath === pathToClose) {
      setActivePath(nextTabs[nextTabs.length - 1]?.path ?? null);
    }
  };

  const visibleEntries = useMemo(() => {
    const all = fileList.data?.entries ?? [];
    const q = filterText.trim().toLowerCase();
    if (q) {
      return all.filter((f: WorkspaceFileEntry) => f.path.toLowerCase().includes(q));
    }
    return all.filter((entry: WorkspaceFileEntry) => {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parentPath = parts.slice(0, i).join('/');
        if (collapsedDirs.has(parentPath)) return false;
      }
      return true;
    });
  }, [fileList.data, filterText, collapsedDirs]);

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const isLightTheme =
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';

  const activeFileDescriptor = useMemo(
    () => (activeTab ? describeFileType(activeTab.path) : null),
    [activeTab],
  );

  return (
    <div
      className="code-explorer-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 56px)',
        gap: '10px',
      }}
    >
      {/* Top Bar */}
      <div
        className="panel"
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span className="badge badge-soft mono" style={{ fontWeight: 600 }}>
            ◫ Code Explorer
          </span>
          <strong>{project?.name ?? projectId}</strong>
          <span className="muted mono small">{fileList.data?.workspacePath ?? project?.path}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <label className="small muted" htmlFor="code-target-select">
            Target:
          </label>
          <select
            id="code-target-select"
            className="input"
            style={{ width: 'auto', padding: '4px 8px', fontSize: '0.78rem' }}
            value={targetId}
            onChange={(e) => {
              setTargetId(e.target.value);
              setTabs([]);
              setActivePath(null);
            }}
          >
            <option value="main">Main Workspace ({project?.defaultBranch ?? 'main'})</option>
            {projectRuns.map((r) => (
              <option key={r.id} value={r.id}>
                Worktree · {r.title ?? r.branch} ({r.state})
              </option>
            ))}
          </select>

          <Link href={`/projects/${projectId}/board`} className="btn btn-sm btn-ghost">
            ▤ Kanban Board
          </Link>
          <a
            href={`/api/projects/${projectId}/export.tar.gz`}
            className="btn btn-sm btn-ghost"
            title="Download workspace as .tar.gz archive"
          >
            📦 Download .tar.gz
          </a>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" style={{ margin: 0 }}>
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="banner banner-ok" style={{ margin: 0 }}>
          {statusMessage}
        </div>
      )}

      {/* Main Split Workbench */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: '290px 1fr',
          gap: '10px',
        }}
      >
        {/* Left File Tree Sidebar */}
        <aside
          className="panel"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverTree(true);
          }}
          onDragLeave={() => setDragOverTree(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverTree(false);
            if (e.dataTransfer.files?.length) {
              void handleUploadFiles(e.dataTransfer.files);
            }
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            padding: '10px',
            gap: '8px',
            border: dragOverTree ? '2px dashed var(--ember-1)' : undefined,
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files?.length) {
                void handleUploadFiles(e.target.files);
              }
            }}
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
            }}
          >
            <span className="eyebrow">
              Files (
              {(fileList.data?.entries ?? []).filter((f: WorkspaceFileEntry) => f.kind === 'file')
                .length}
              )
            </span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ padding: '2px 6px', fontSize: '0.72rem' }}
                title="Upload files (or drag and drop onto the sidebar)"
                onClick={() => setShowUploadBox((v) => !v)}
              >
                ⬆ Upload
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ padding: '2px 6px', fontSize: '0.72rem' }}
                onClick={() => setCreatingFile((v) => !v)}
              >
                + File
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ padding: '2px 6px', fontSize: '0.72rem' }}
                onClick={() => void fileList.refresh()}
                title="Refresh workspace files"
              >
                ↻
              </button>
            </div>
          </div>

          {showUploadBox && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '8px',
                borderRadius: '6px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
              }}
            >
              <label className="small muted" style={{ fontSize: '0.72rem' }}>
                Target Folder (optional):
              </label>
              <input
                className="input mono"
                style={{ padding: '4px 6px', fontSize: '0.74rem' }}
                placeholder="e.g. public/downloads or src/assets (blank = root)"
                value={uploadTargetDir}
                onChange={(e) => setUploadTargetDir(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  style={{ flex: 1, padding: '4px 8px', fontSize: '0.74rem' }}
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? 'Uploading…' : '⬆ Choose File(s)…'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ padding: '4px 8px', fontSize: '0.72rem' }}
                  onClick={() => setShowUploadBox(false)}
                >
                  Cancel
                </button>
              </div>
              <span className="muted" style={{ fontSize: '0.68rem' }}>
                Tip: You can also drag & drop any file(s) directly onto this file tree.
              </span>
            </div>
          )}

          {creatingFile && (
            <form onSubmit={(e) => void handleCreateFile(e)} style={{ display: 'flex', gap: '4px' }}>
              <input
                className="input mono"
                style={{ flex: 1, padding: '4px 6px', fontSize: '0.75rem' }}
                placeholder="src/newFile.ts"
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                autoFocus
              />
              <button type="submit" className="btn btn-sm btn-primary" style={{ padding: '4px 8px' }}>
                Add
              </button>
            </form>
          )}

          <input
            className="input"
            style={{ padding: '5px 8px', fontSize: '0.78rem' }}
            placeholder="Filter files (e.g. .apk, .ts, dist)…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />

          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
            }}
          >
            {visibleEntries.map((entry: WorkspaceFileEntry) => {
              const depth = entry.path.split('/').length - 1;
              const isDir = entry.kind === 'directory';
              const isCollapsed = isDir && collapsedDirs.has(entry.path);
              const isSelected = !isDir && activePath === entry.path;
              const fileDesc = !isDir ? describeFileType(entry.path) : null;

              return (
                <div
                  key={entry.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 6px',
                    paddingLeft: `${6 + depth * 12}px`,
                    borderRadius: '4px',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--surface-hover)' : 'transparent',
                    borderLeft: isSelected ? '2px solid var(--ember-1)' : '2px solid transparent',
                    fontSize: '0.78rem',
                    gap: '4px',
                  }}
                  onClick={() => {
                    if (isDir) {
                      toggleDir(entry.path);
                      setUploadTargetDir(entry.path);
                    } else {
                      void openFile(entry.path);
                    }
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: isDir || isSelected ? 600 : 400,
                      color: isDir ? 'var(--ember-2)' : 'var(--text)',
                      flex: 1,
                    }}
                    title={
                      isDir
                        ? `${entry.path}/`
                        : `${entry.path} (${formatBytes(entry.sizeBytes)})`
                    }
                  >
                    {isDir
                      ? isCollapsed
                        ? '▸ 📁 '
                        : '▾ 📂 '
                      : `${fileDesc?.icon ?? '📄'} `}
                    {entry.name}
                  </span>
                  {!isDir && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '2px',
                        flexShrink: 0,
                      }}
                    >
                      {entry.sizeBytes >= 100 * 1024 && (
                        <span
                          className="muted mono"
                          style={{ fontSize: '0.66rem', marginRight: '2px' }}
                        >
                          {formatBytes(entry.sizeBytes)}
                        </span>
                      )}
                      <a
                        href={getFileDownloadUrl(projectId, targetId, entry.path)}
                        download={entry.name}
                        className="btn btn-ghost btn-sm"
                        style={{
                          padding: '0 4px',
                          fontSize: '0.7rem',
                          opacity: 0.75,
                          textDecoration: 'none',
                        }}
                        title={`Download ${entry.path} (${formatBytes(entry.sizeBytes)})`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⬇
                      </a>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: '0 4px', fontSize: '0.68rem', opacity: 0.6 }}
                        title={`Delete ${entry.path}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteFile(entry.path);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
            {visibleEntries.length === 0 && (
              <p className="muted small" style={{ padding: '8px' }}>
                No matching files in workspace.
              </p>
            )}
          </div>
        </aside>

        {/* Right Monaco Editor / Universal File Inspector Area */}
        <section
          className="panel"
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            padding: 0,
            overflow: 'hidden',
          }}
        >
          {/* Open File Tabs Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'var(--surface-2)',
              borderBottom: '1px solid var(--border)',
              padding: '4px 8px',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflowX: 'auto' }}>
              {tabs.map((tab) => {
                const isDirty = !tab.binary && tab.content !== tab.savedContent;
                const active = tab.path === activePath;
                const desc = describeFileType(tab.path);
                return (
                  <div
                    key={tab.path}
                    onClick={() => setActivePath(tab.path)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '5px 10px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '0.78rem',
                      background: active ? 'var(--surface)' : 'transparent',
                      border: active ? '1px solid var(--border-strong)' : '1px solid transparent',
                    }}
                  >
                    <span>{desc.icon}</span>
                    <span className="mono">{tab.path}</span>
                    {isDirty && (
                      <span
                        style={{ color: 'var(--ember-1)', fontWeight: 700 }}
                        title="Unsaved changes"
                      >
                        ●
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => closeTab(tab.path, e)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--muted)',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: '0.82rem',
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {tabs.length === 0 && (
                <span className="muted small">Select a file from the tree to view, download, or edit</span>
              )}
            </div>

            {activeTab && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                <span className="badge mono" title="File size">
                  {formatBytes(activeTab.sizeBytes)}
                </span>
                {!activeTab.binary && (
                  <span className="badge mono">{detectLanguage(activeTab.path)}</span>
                )}
                <a
                  href={getFileDownloadUrl(projectId, targetId, activeTab.path)}
                  download={activeTab.path.split('/').pop() ?? activeTab.path}
                  className="btn btn-sm btn-ghost"
                  style={{ textDecoration: 'none' }}
                  title={`Download ${activeTab.path}`}
                >
                  ⬇ Download
                </a>
                {!activeTab.binary && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={saving || activeTab.content === activeTab.savedContent}
                    onClick={() => void saveActiveFile()}
                  >
                    {saving ? 'Saving…' : '💾 Save (⌘S)'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Monaco Editor / Non-Text File Inspector Stage */}
          <div style={{ flex: 1, minHeight: 0, position: 'relative', overflowY: 'auto' }}>
            {activeTab ? (
              activeTab.loading ? (
                <div style={{ padding: '24px' }} className="muted mono">
                  Loading {activeTab.path}…
                </div>
              ) : activeTab.binary ? (
                <div
                  style={{
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '28px',
                  }}
                >
                  <div
                    className="panel"
                    style={{
                      maxWidth: '580px',
                      width: '100%',
                      padding: '24px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      textAlign: 'center',
                      gap: '14px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-strong)',
                    }}
                  >
                    <div style={{ fontSize: '2.6rem', lineHeight: 1 }}>
                      {activeFileDescriptor?.icon ?? '📦'}
                    </div>
                    <div>
                      <h3 style={{ margin: '0 0 4px 0', fontSize: '1.05rem' }}>
                        {activeTab.path.split('/').pop() ?? activeTab.path}
                      </h3>
                      <div className="muted mono small">{activeTab.path}</div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        flexWrap: 'wrap',
                        justifyContent: 'center',
                      }}
                    >
                      <span className="badge badge-soft">
                        {activeFileDescriptor?.label ?? 'Binary / Non-Text File'}
                      </span>
                      <span className="badge mono">{formatBytes(activeTab.sizeBytes)}</span>
                    </div>

                    {activeFileDescriptor?.previewKind === 'image' && (
                      <div
                        style={{
                          padding: '12px',
                          background: 'var(--surface)',
                          borderRadius: '8px',
                          border: '1px solid var(--border)',
                          maxWidth: '100%',
                        }}
                      >
                        <img
                          src={getFileDownloadUrl(projectId, targetId, activeTab.path, true)}
                          alt={activeTab.path}
                          style={{
                            maxWidth: '100%',
                            maxHeight: '280px',
                            objectFit: 'contain',
                            display: 'block',
                          }}
                        />
                      </div>
                    )}

                    {activeFileDescriptor?.previewKind === 'audio' && (
                      <audio
                        controls
                        src={getFileDownloadUrl(projectId, targetId, activeTab.path, true)}
                        style={{ width: '100%', maxWidth: '420px' }}
                      />
                    )}

                    {activeFileDescriptor?.previewKind === 'video' && (
                      <video
                        controls
                        src={getFileDownloadUrl(projectId, targetId, activeTab.path, true)}
                        style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '6px' }}
                      />
                    )}

                    <p className="muted small" style={{ margin: 0, maxWidth: '460px' }}>
                      This file is a binary, package, or media artifact and cannot be displayed or
                      edited as plain text in the code editor. You can download it directly to your
                      device below.
                    </p>

                    <div
                      style={{
                        display: 'flex',
                        gap: '10px',
                        flexWrap: 'wrap',
                        justifyContent: 'center',
                        marginTop: '4px',
                      }}
                    >
                      <a
                        href={getFileDownloadUrl(projectId, targetId, activeTab.path)}
                        download={activeTab.path.split('/').pop() ?? activeTab.path}
                        className="btn btn-primary"
                        style={{ textDecoration: 'none', padding: '8px 16px' }}
                      >
                        ⬇ Download {activeTab.path.split('/').pop()} (
                        {formatBytes(activeTab.sizeBytes)})
                      </a>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void handleDeleteFile(activeTab.path)}
                      >
                        🗑 Delete File
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <StandaloneMonacoEditor
                  filePath={`${targetId}:${activeTab.path}`}
                  language={detectLanguage(activeTab.path)}
                  theme={isLightTheme ? 'vs' : 'vs-dark'}
                  value={activeTab.content}
                  onChange={(nextVal: string) => {
                    setTabs((prev) =>
                      prev.map((t) =>
                        t.path === activeTab.path ? { ...t, content: nextVal } : t,
                      ),
                    );
                  }}
                />
              )
            ) : (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--muted)',
                }}
              >
                Choose a file on the left to inspect, download, or edit directly in `/workspaces/
                {project?.slug}`.
              </div>
            )}
          </div>

          {/* Ask Specialist Agent about Active File Bar */}
          {activeTab && (
            <form
              onSubmit={(e) => void handleAskAgentOnFile(e)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                borderTop: '1px solid var(--border)',
                background: 'var(--surface-2)',
                flexWrap: 'wrap',
              }}
            >
              <span className="small mono" style={{ fontWeight: 600 }}>
                ✨ Ask Agent on `{activeTab.path}`:
              </span>
              <select
                className="input"
                style={{ width: 'auto', padding: '4px 8px', fontSize: '0.76rem' }}
                value={agentPersona}
                onChange={(e) => setAgentPersona(e.target.value as AgentPersona)}
              >
                {PERSONA_LIST.map((p) => (
                  <option key={p.id} value={p.id}>
                    [{p.shortLabel}] {p.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ width: 'auto', flex: '1 1 220px', padding: '5px 8px', fontSize: '0.78rem' }}
                placeholder={`e.g. "Update or inspect ${activeTab.path}"`}
                value={agentPrompt}
                onChange={(e) => setAgentPrompt(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={dispatchingAgent || !agentPrompt.trim()}
              >
                {dispatchingAgent ? 'Dispatching…' : '🚀 Dispatch to Agent'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
