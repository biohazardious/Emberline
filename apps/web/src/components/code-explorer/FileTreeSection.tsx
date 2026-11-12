import type { UploadWorkspaceFilesResponse, WorkspaceFileContentResponse } from '@emberline/protocol';
import { isEmberlineDirPath, isWorktreeYmlPath } from '@emberline/protocol';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { ico } from '../SectionState';
import {
  CE_TREE_BTN,
  describeFileType,
  type ExplorerCtx,
  formatBytes,
  getFileDownloadUrl,
  readFileAsBase64,
} from './fileTypes';

export function FileTreeSection({
  ctx,
  loading,
  loadError,
}: {
  ctx: ExplorerCtx;
  loading?: boolean;
  loadError?: unknown;
}) {
  const { pid, fbase, tid, entries, active, refresh, open, del, uploaded, setErr, setMsg } = ctx;
  const [filterText, setFilterText] = useState('');
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [uploadTargetDir, setUploadTargetDir] = useState('');
  const [showUploadBox, setShowUploadBox] = useState(false);
  const [dragOverTree, setDragOverTree] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUploadFiles = useCallback(
    async (fileItems: FileList | File[]) => {
      const list = Array.from(fileItems);
      if (list.length === 0) return;
      setUploading(true);
      setErr(null);
      setMsg(null);
      try {
        const cleanPrefix = uploadTargetDir
          .trim()
          .replace(/\\/g, '/')
          .replace(/^\/+|\/+$/g, '');
        const payloadFiles = await Promise.all(
          list.map(async (file) => {
            const dataBase64 = await readFileAsBase64(file);
            const relName = file.name.replace(/\\/g, '/').replace(/^\/+/, '');
            return { path: cleanPrefix ? `${cleanPrefix}/${relName}` : relName, dataBase64 };
          }),
        );
        const res = await api<UploadWorkspaceFilesResponse>(`${fbase}/upload`, 'POST', {
          targetId: tid,
          files: payloadFiles,
        });
        setMsg(`Uploaded ${res.uploadedPaths.length} file(s): ${res.uploadedPaths.join(', ')}`);
        setShowUploadBox(false);
        await refresh();
        await uploaded(res.uploadedPaths);
      } catch (err) {
        setErr(errorMessage(err));
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [fbase, tid, uploadTargetDir, refresh, uploaded, setErr, setMsg],
  );

  const handleCreateFile = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = newFilePath.trim().replace(/^\/+/, '');
    if (!cleaned) return;
    setErr(null);
    try {
      await api<WorkspaceFileContentResponse>(`${fbase}/content`, 'PUT', {
        targetId: tid,
        path: cleaned,
        content: '',
      });
      setNewFilePath('');
      setCreatingFile(false);
      await refresh();
      await open(cleaned);
    } catch (err) {
      setErr(errorMessage(err));
    }
  };

  const visibleEntries = useMemo(() => {
    const all = entries ?? [];
    const q = filterText.trim().toLowerCase();
    if (q) return all.filter((f) => f.path.toLowerCase().includes(q));
    return all.filter((entry) => {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (collapsedDirs.has(parts.slice(0, i).join('/'))) return false;
      }
      return true;
    });
  }, [entries, filterText, collapsedDirs]);

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const totalFileCount = (entries ?? []).filter((f) => f.kind === 'file').length;

  return (
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
        if (e.dataTransfer.files?.length) void handleUploadFiles(e.dataTransfer.files);
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
          if (e.target.files?.length) void handleUploadFiles(e.target.files);
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
        <span className="eyebrow">Files ({totalFileCount})</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={CE_TREE_BTN}
            title="Upload files (or drag and drop onto the sidebar)"
            onClick={() => setShowUploadBox((v) => !v)}
          >
            {ico(Upload)} Upload
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={CE_TREE_BTN}
            onClick={() => setCreatingFile((v) => !v)}
          >
            + File
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={CE_TREE_BTN}
            onClick={() => void refresh()}
            title="Refresh workspace files"
            aria-label="Refresh workspace files"
          >
            {ico(RefreshCw)}
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
              {uploading ? 'Uploading…' : <>{ico(Upload)} Choose File(s)…</>}
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
            Tip: You can also drag &amp; drop any file(s) directly onto this file tree.
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

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {entries === undefined && loadError !== undefined ? (
          <div style={{ padding: '8px' }}>
            <p className="form-error" role="alert">
              Could not load files: {errorMessage(loadError)}{' '}
              <button type="button" className="btn btn-xs" onClick={() => void refresh()}>
                Retry
              </button>
            </p>
          </div>
        ) : entries === undefined && loading ? (
          <p className="muted small" aria-busy="true" style={{ padding: '8px' }}>
            Loading workspace files…
          </p>
        ) : (
          <>
            {visibleEntries.map((entry) => {
              const depth = entry.path.split('/').length - 1;
              const isDir = entry.kind === 'directory';
              const isCollapsed = isDir && collapsedDirs.has(entry.path);
              const isSelected = !isDir && active === entry.path;
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
                      void open(entry.path);
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
                    title={isDir ? `${entry.path}/` : `${entry.path} (${formatBytes(entry.sizeBytes)})`}
                  >
                    {isDir ? (
                      isCollapsed ? (
                        <>
                          {ico(ChevronRight)} {ico(Folder)}
                        </>
                      ) : (
                        <>
                          {ico(ChevronDown)} {ico(FolderOpen)}
                        </>
                      )
                    ) : (
                      ico(fileDesc?.icon ?? FileText)
                    )}{' '}
                    {entry.name}
                  </span>
                  {!isDir && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                      {entry.sizeBytes >= 100 * 1024 && (
                        <span className="muted mono" style={{ fontSize: '0.66rem', marginRight: '2px' }}>
                          {formatBytes(entry.sizeBytes)}
                        </span>
                      )}
                      <a
                        href={getFileDownloadUrl(pid, tid, entry.path)}
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
                        {ico(Download)}
                      </a>
                      {!isWorktreeYmlPath(entry.path) && !isEmberlineDirPath(entry.path) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '0 4px', fontSize: '0.68rem', opacity: 0.6 }}
                          title={`Delete ${entry.path}`}
                          aria-label={`Delete ${entry.path}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void del(entry.path);
                          }}
                        >
                          {ico(X)}
                        </button>
                      )}
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
          </>
        )}
      </div>
    </aside>
  );
}
