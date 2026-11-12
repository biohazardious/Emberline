import type { WorkspaceFileContentResponse, WorkspaceFileEntry } from '@emberline/protocol';
import { isEmberlineDirPath, isWorktreeYmlPath } from '@emberline/protocol';
import { type MouseEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { EditorStageSection } from '../components/code-explorer/EditorStageSection';
import { ExplorerToolbarSection } from '../components/code-explorer/ExplorerToolbarSection';
import { FileTreeSection } from '../components/code-explorer/FileTreeSection';
import type { ExplorerCtx, OpenTab } from '../components/code-explorer/fileTypes';
import { useRuns } from '../hooks/liveData';
import { useProject } from '../hooks/useProjects';
import { useWorkspaceFileLoader, useWorkspaceFiles } from '../hooks/useWorkspaceFiles';

export function CodeExplorerPage({ projectId }: { projectId: string }) {
  const {
    project,
    loading: projectLoading,
    error: projectError,
    refresh: refreshProject,
  } = useProject(projectId, 15_000);
  const { runs } = useRuns();
  const projectRuns = useMemo(() => (runs ?? []).filter((r) => r.projectId === projectId), [runs, projectId]);

  const [targetId, setTargetId] = useState<string>('main');
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fbase = `/api/projects/${projectId}/files`;

  const fileList = useWorkspaceFiles(projectId, targetId);
  const loadWorkspaceFile = useWorkspaceFileLoader(projectId, targetId);

  const openFile = useCallback(
    async (relPath: string) => {
      setError(null);
      setActivePath(relPath);
      const existing = tabs.find((t) => t.path === relPath);
      if (existing && !existing.error) return;

      setTabs((prev) => {
        const nextTab: OpenTab = {
          path: relPath,
          content: '',
          savedContent: '',
          loading: true,
          binary: false,
          sizeBytes: 0,
        };
        return existing ? prev.map((t) => (t.path === relPath ? nextTab : t)) : [...prev, nextTab];
      });
      try {
        const res = await loadWorkspaceFile(relPath);
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
                  error: undefined,
                }
              : t,
          ),
        );
      } catch (err) {
        setError(errorMessage(err));
        setTabs((prev) => prev.filter((t) => t.path !== relPath));
      }
    },
    [tabs, loadWorkspaceFile],
  );

  // Auto-open PROJECT.md, README.md, entry file, or first file on initial load.
  useEffect(() => {
    if (tabs.length > 0 || activePath) return;
    const files = (fileList.data?.entries ?? []).filter((f: WorkspaceFileEntry) => f.kind === 'file');
    if (files.length === 0) return;
    const preferred =
      files.find((f) => f.path === 'PROJECT.md') ??
      files.find((f) => f.path === 'README.md') ??
      files.find((f) => f.path === 'src/App.tsx' || f.path === 'src/main.ts' || f.path === 'src/index.ts') ??
      files.find((f) => f.path === 'index.html') ??
      files[0];
    if (preferred) void openFile(preferred.path);
  }, [fileList.data, tabs.length, activePath, openFile]);

  const activeTab = useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [tabs, activePath]);

  const saveActiveFile = useCallback(async () => {
    if (!activeTab || activeTab.binary || isWorktreeYmlPath(activeTab.path)) return;
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await api<WorkspaceFileContentResponse>(`${fbase}/content`, 'PUT', {
        targetId,
        path: activeTab.path,
        content: activeTab.content,
      });
      setTabs((prev) =>
        prev.map((t) =>
          t.path === activeTab.path ? { ...t, savedContent: res.content, sizeBytes: res.sizeBytes } : t,
        ),
      );
      setStatusMessage(`Saved ${activeTab.path}`);
      await fileList.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [activeTab, fbase, targetId, fileList]);

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

  const handleDeleteFile = async (relPath: string) => {
    if (isWorktreeYmlPath(relPath) || isEmberlineDirPath(relPath)) return;
    if (!window.confirm(`Delete "${relPath}" from workspace?`)) return;
    setError(null);
    try {
      await api(fbase, 'DELETE', {
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
      setError(errorMessage(err));
    }
  };

  const closeTab = (pathToClose: string, e: MouseEvent) => {
    e.stopPropagation();
    const nextTabs = tabs.filter((t) => t.path !== pathToClose);
    setTabs(nextTabs);
    if (activePath === pathToClose) {
      setActivePath(nextTabs[nextTabs.length - 1]?.path ?? null);
    }
  };

  const ctx: ExplorerCtx = {
    pid: projectId,
    fbase,
    proj: project,
    tid: targetId,
    setTid: (next) => {
      setTargetId(next);
      setTabs([]);
      setActivePath(null);
    },
    runs: projectRuns,
    wsPath: fileList.data?.workspacePath,
    entries: fileList.data?.entries,
    tabs,
    active: activePath,
    tab: activeTab,
    saving,
    err: error,
    setErr: setError,
    msg: statusMessage,
    setMsg: setStatusMessage,
    refresh: fileList.refresh,
    open: openFile,
    del: handleDeleteFile,
    uploaded: async (uploadedPaths) => {
      const firstUploaded = uploadedPaths[0];
      if (firstUploaded) {
        setTabs((prev) => prev.filter((t) => !uploadedPaths.includes(t.path)));
        await openFile(firstUploaded);
      }
    },
    selTab: setActivePath,
    closeTab,
    editTab: (path, nextContent) =>
      setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, content: nextContent } : t))),
    save: saveActiveFile,
  };

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
      <ExplorerToolbarSection
        ctx={ctx}
        loading={projectLoading}
        error={projectError}
        onRetry={refreshProject}
      />

      <div
        className="code-explorer-grid"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gap: '10px',
        }}
      >
        <FileTreeSection ctx={ctx} loading={fileList.loading} loadError={fileList.error} />
        <EditorStageSection ctx={ctx} />
      </div>
    </div>
  );
}
