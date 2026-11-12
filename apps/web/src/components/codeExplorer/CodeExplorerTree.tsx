import type { WorkspaceFileEntry } from '@emberline/protocol';
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
import { type FormEvent, useRef, useState } from 'react';
import { SearchInput } from '../BoardFilterBar';
import { ViewLoadingState } from '../ErrorBoundary';
import { describeFileType, FileTypeIcon, formatBytes, getFileDownloadUrl } from './fileTypes';

export function CodeExplorerTree({
  projectId,
  targetId,
  allEntries,
  visibleEntries,
  loading,
  hasData,
  hasError,
  filterText,
  onFilterTextChange,
  collapsedDirs,
  onToggleDir,
  activePath,
  onOpenFile,
  onDeleteFile,
  onRefresh,
  uploading,
  uploadTargetDir,
  onUploadTargetDirChange,
  onUploadFiles,
  onCreateFile,
}: {
  projectId: string;
  targetId: string;
  allEntries: WorkspaceFileEntry[];
  visibleEntries: WorkspaceFileEntry[];
  loading: boolean;
  hasData: boolean;
  hasError: boolean;
  filterText: string;
  onFilterTextChange: (next: string) => void;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (dirPath: string) => void;
  activePath: string | null;
  onOpenFile: (relPath: string) => void;
  onDeleteFile: (relPath: string) => void;
  onRefresh: () => void;
  uploading: boolean;
  uploadTargetDir: string;
  onUploadTargetDirChange: (next: string) => void;
  onUploadFiles: (files: FileList | File[]) => Promise<void>;
  onCreateFile: (relPath: string) => Promise<boolean>;
}) {
  const [showUploadBox, setShowUploadBox] = useState(false);
  const [dragOverTree, setDragOverTree] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fileCount = allEntries.filter((f) => f.kind === 'file').length;

  const submitNewFile = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = newFilePath.trim().replace(/^\/+/, '');
    if (!cleaned) return;
    const ok = await onCreateFile(cleaned);
    if (ok) {
      setNewFilePath('');
      setCreatingFile(false);
    }
  };

  const triggerUpload = async (files: FileList | File[]) => {
    await onUploadFiles(files);
    setShowUploadBox(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

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
        if (e.dataTransfer.files?.length) {
          void triggerUpload(e.dataTransfer.files);
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
            void triggerUpload(e.target.files);
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
        <span className="eyebrow">Files ({fileCount})</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ padding: '2px 6px', fontSize: '0.72rem' }}
            title="Upload files (or drag and drop onto the sidebar)"
            onClick={() => setShowUploadBox((v) => !v)}
          >
            <Upload className="icon" aria-hidden /> Upload
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
            onClick={onRefresh}
            title="Refresh workspace files"
            aria-label="Refresh workspace files"
          >
            <RefreshCw className="icon" aria-hidden />
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
            onChange={(e) => onUploadTargetDirChange(e.target.value)}
          />
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              style={{ flex: 1, padding: '4px 8px', fontSize: '0.74rem' }}
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? (
                'Uploading…'
              ) : (
                <>
                  <Upload className="icon" aria-hidden /> Choose File(s)…
                </>
              )}
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
        <form onSubmit={(e) => void submitNewFile(e)} style={{ display: 'flex', gap: '4px' }}>
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

      <SearchInput
        ariaLabel="Filter workspace files"
        placeholder="Filter files (e.g. .apk, .ts, dist)…"
        value={filterText}
        onChange={onFilterTextChange}
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
        {loading && !hasData && !hasError && <ViewLoadingState compact label="Loading workspace files…" />}
        {visibleEntries.map((entry) => {
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
                  onToggleDir(entry.path);
                  onUploadTargetDirChange(entry.path);
                } else {
                  onOpenFile(entry.path);
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
                      <ChevronRight className="icon" aria-hidden /> <Folder className="icon" aria-hidden />
                    </>
                  ) : (
                    <>
                      <ChevronDown className="icon" aria-hidden /> <FolderOpen className="icon" aria-hidden />
                    </>
                  )
                ) : (
                  <FileTypeIcon icon={fileDesc?.icon ?? FileText} />
                )}{' '}
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
                    <span className="muted mono" style={{ fontSize: '0.66rem', marginRight: '2px' }}>
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
                    <Download className="icon" aria-hidden />
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
                        onDeleteFile(entry.path);
                      }}
                    >
                      <X className="icon" aria-hidden />
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
        {visibleEntries.length === 0 && !loading && (
          <p className="muted small" style={{ padding: '8px' }}>
            {filterText.trim() ? 'No files match the filter.' : 'No matching files in workspace.'}
          </p>
        )}
      </div>
    </aside>
  );
}
