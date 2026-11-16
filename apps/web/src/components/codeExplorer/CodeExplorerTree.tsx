import type { WorkspaceFileEntry } from '@emberline/protocol';
import { isEmberlineDirPath, isWorktreeYmlPath } from '@emberline/protocol';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { SearchInput } from '../BoardFilterBar';
import { ViewErrorBanner, ViewLoadingState } from '../ErrorBoundary';
import { describeFileType, FileTypeIcon, formatBytes, getFileDownloadUrl } from './fileTypes';

export function CodeExplorerTree({
  projectId,
  targetId,
  allEntries,
  visibleEntries,
  loading,
  hasData,
  hasError,
  loadError,
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
  loadError?: unknown;
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
      className={`panel code-tree-panel${dragOverTree ? ' code-tree-panel-drag' : ''}`}
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
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="code-tree-file-input"
        onChange={(e) => {
          if (e.target.files?.length) {
            void triggerUpload(e.target.files);
          }
        }}
      />

      <div className="code-tree-header">
        <span className="eyebrow code-tree-heading">Files ({fileCount})</span>
        <div className="code-tree-header-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost code-tree-action-btn"
            onClick={() => setCreatingFile((v) => !v)}
          >
            <FilePlus className="icon" aria-hidden /> Create file
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost code-tree-action-btn"
            onClick={() => setShowUploadBox((v) => !v)}
          >
            <Upload className="icon" aria-hidden /> Upload files
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost code-tree-action-btn"
            onClick={onRefresh}
            aria-label="Refresh workspace files"
          >
            <RefreshCw className="icon" aria-hidden />
          </button>
        </div>
      </div>

      {showUploadBox && (
        <div className="code-tree-upload-box">
          <label className="small muted code-tree-upload-label" htmlFor="code-upload-folder">
            Target folder (optional)
          </label>
          <input
            id="code-upload-folder"
            className="input mono code-tree-upload-input"
            placeholder="public/downloads (blank = root)"
            value={uploadTargetDir}
            onChange={(e) => onUploadTargetDirChange(e.target.value)}
          />
          <div className="code-tree-upload-actions">
            <button
              type="button"
              className="btn btn-sm code-tree-upload-choose"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? (
                'Uploading…'
              ) : (
                <>
                  <Upload className="icon" aria-hidden /> Choose files
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost code-tree-action-btn"
              onClick={() => setShowUploadBox(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {creatingFile && (
        <form onSubmit={(e) => void submitNewFile(e)} className="code-tree-create-form">
          <input
            className="input mono code-tree-create-input"
            aria-label="New file path"
            placeholder="src/newFile.ts"
            value={newFilePath}
            onChange={(e) => setNewFilePath(e.target.value)}
            autoFocus
          />
          <button type="submit" className="btn btn-sm code-tree-create-btn">
            Add file
          </button>
        </form>
      )}

      <SearchInput
        className="code-explorer-search"
        ariaLabel="Filter workspace files"
        placeholder="Filter files…"
        value={filterText}
        onChange={onFilterTextChange}
      />

      <div className="code-tree-list">
        {loading && !hasData && !hasError && <ViewLoadingState compact label="Loading workspace files…" />}
        {loadError !== undefined && !hasData && (
          <ViewErrorBanner
            compact
            label="Could not load workspace files"
            error={loadError}
            onRetry={onRefresh}
          />
        )}
        {visibleEntries.map((entry) => {
          const depth = entry.path.split('/').length - 1;
          const isDir = entry.kind === 'directory';
          const isCollapsed = isDir && collapsedDirs.has(entry.path);
          const isSelected = !isDir && activePath === entry.path;
          const fileDesc = !isDir ? describeFileType(entry.path) : null;

          return (
            <div
              key={entry.path}
              className={`code-tree-row${isSelected ? ' code-tree-row-selected' : ''}`}
              style={{ paddingLeft: `${6 + depth * 12}px` }}
              onClick={() => {
                if (isDir) {
                  onToggleDir(entry.path);
                  onUploadTargetDirChange(entry.path);
                } else {
                  onOpenFile(entry.path);
                }
              }}
            >
              <span className={`mono code-tree-row-name${isDir ? ' code-tree-row-dir' : ''}`}>
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
                <span className="code-tree-row-meta">
                  {entry.sizeBytes >= 100 * 1024 && (
                    <span className="muted mono code-tree-row-size">{formatBytes(entry.sizeBytes)}</span>
                  )}
                  <a
                    href={getFileDownloadUrl(projectId, targetId, entry.path)}
                    download={entry.name}
                    className="btn btn-ghost btn-sm code-tree-row-icon-btn"
                    aria-label={`Download ${entry.path}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Download className="icon" aria-hidden />
                  </a>
                  {!isWorktreeYmlPath(entry.path) && !isEmberlineDirPath(entry.path) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm code-tree-row-icon-btn"
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
        {visibleEntries.length === 0 && !loading && !hasError && loadError === undefined && (
          <p className="muted small code-tree-empty">
            {filterText.trim() ? 'No files match the filter.' : 'No matching files in workspace.'}
          </p>
        )}
      </div>
    </aside>
  );
}
