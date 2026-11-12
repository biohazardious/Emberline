import type {
  AgentPersona,
  FactoryRequestResponse,
  Project,
  UploadWorkspaceFilesResponse,
  WorkspaceFileContentResponse,
  WorkspaceFileEntry,
  WorkspaceFileListResponse,
} from '@emberline/protocol';
import { isEmberlineDirPath, isWorktreeYmlPath } from '@emberline/protocol';
import { FileCode2, Package, SquareKanban } from 'lucide-react';
import { type FormEvent, type MouseEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { CodeExplorerStage } from '../components/codeExplorer/CodeExplorerStage';
import { CodeExplorerTree } from '../components/codeExplorer/CodeExplorerTree';
import { type OpenTab, readFileAsBase64 } from '../components/codeExplorer/fileTypes';
import { ViewErrorBanner } from '../components/ErrorBoundary';
import { PERSONA_BY_ID } from '../components/PersonaBadge';
import { useRuns } from '../hooks/liveData';
import { useApi } from '../hooks/useApi';
import { useThemeMode } from '../hooks/useThemeMode';

export function CodeExplorerPage({ projectId }: { projectId: string }) {
  const projects = useApi<Project[]>('/api/projects', 15_000);
  const { runs } = useRuns();
  const project = useMemo(
    () => (projects.data ?? []).find((p) => p.id === projectId),
    [projects.data, projectId],
  );
  const projectRuns = useMemo(() => (runs ?? []).filter((r) => r.projectId === projectId), [runs, projectId]);

  const [targetId, setTargetId] = useState<string>('main');
  const [filterText, setFilterText] = useState('');
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadTargetDir, setUploadTargetDir] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentPersona, setAgentPersona] = useState<AgentPersona>('coder');
  const [dispatchingAgent, setDispatchingAgent] = useState(false);

  const fileList = useApi<WorkspaceFileListResponse>(
    `/api/projects/${projectId}/files?targetId=${encodeURIComponent(targetId)}`,
    6_000,
  );

  const openFile = useCallback(
    async (relPath: string) => {
      setError(null);
      setActivePath(relPath);
      if (tabs.some((t) => t.path === relPath)) return;

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
        setError(errorMessage(err));
        setTabs((prev) => prev.filter((t) => t.path !== relPath));
      }
    },
    [projectId, targetId, tabs],
  );

  useEffect(() => {
    if (tabs.length > 0 || activePath) return;
    const files = (fileList.data?.entries ?? []).filter((f: WorkspaceFileEntry) => f.kind === 'file');
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
    if (preferred) void openFile(preferred.path);
  }, [fileList.data, tabs.length, activePath, openFile]);

  const activeTab = useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [tabs, activePath]);

  const saveActiveFile = useCallback(async () => {
    if (!activeTab || activeTab.binary || isWorktreeYmlPath(activeTab.path)) return;
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await api<WorkspaceFileContentResponse>(`/api/projects/${projectId}/files/content`, 'PUT', {
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
            return {
              path: cleanPrefix ? `${cleanPrefix}/${relName}` : relName,
              dataBase64,
            };
          }),
        );
        const res = await api<UploadWorkspaceFilesResponse>(
          `/api/projects/${projectId}/files/upload`,
          'POST',
          { targetId, files: payloadFiles },
        );
        setStatusMessage(`Uploaded ${res.uploadedPaths.length} file(s): ${res.uploadedPaths.join(', ')}`);
        await fileList.refresh();
        const firstUploaded = res.uploadedPaths[0];
        if (firstUploaded) {
          setTabs((prev) => prev.filter((t) => !res.uploadedPaths.includes(t.path)));
          await openFile(firstUploaded);
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setUploading(false);
      }
    },
    [projectId, targetId, uploadTargetDir, fileList, openFile],
  );

  const handleCreateFile = async (cleaned: string): Promise<boolean> => {
    setError(null);
    try {
      await api<WorkspaceFileContentResponse>(`/api/projects/${projectId}/files/content`, 'PUT', {
        targetId,
        path: cleaned,
        content: '',
      });
      await fileList.refresh();
      await openFile(cleaned);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };

  const handleDeleteFile = async (relPath: string) => {
    if (isWorktreeYmlPath(relPath) || isEmberlineDirPath(relPath)) return;
    if (!window.confirm(`Delete "${relPath}" from workspace?`)) return;
    setError(null);
    try {
      await api(`/api/projects/${projectId}/files`, 'DELETE', { targetId, path: relPath });
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

  const handleAskAgentOnFile = async (e: FormEvent) => {
    e.preventDefault();
    if (!agentPrompt.trim() || !activeTab) return;
    setDispatchingAgent(true);
    setError(null);
    setStatusMessage(null);
    try {
      const contextualPrompt = `Target File: \`${activeTab.path}\`\n\nTask: ${agentPrompt.trim()}`;
      const res = await api<FactoryRequestResponse>(`/api/projects/${projectId}/factory-request`, 'POST', {
        prompt: contextualPrompt,
        leadPersona: agentPersona,
        permissionMode: 'auto',
        autoDispatch: true,
      });
      setAgentPrompt('');
      setStatusMessage(
        `Dispatched ${res.ticket.key} (${PERSONA_BY_ID[agentPersona].label}) for ${activeTab.path}`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDispatchingAgent(false);
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

  const visibleEntries = useMemo(() => {
    const all = fileList.data?.entries ?? [];
    const q = filterText.trim().toLowerCase();
    if (q) return all.filter((f: WorkspaceFileEntry) => f.path.toLowerCase().includes(q));
    return all.filter((entry: WorkspaceFileEntry) => {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (collapsedDirs.has(parts.slice(0, i).join('/'))) return false;
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

  const themeMode = useThemeMode();

  return (
    <div className="code-explorer-page">
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0 }}>
          <span className="badge badge-soft mono" style={{ fontWeight: 600 }}>
            <FileCode2 className="icon" aria-hidden /> Code Explorer
          </span>
          <strong>{project?.name ?? projectId}</strong>
          <span className="muted mono small" style={{ overflowWrap: 'anywhere' }}>
            {fileList.data?.workspacePath ?? project?.path}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          <label className="small muted" htmlFor="code-target-select">
            Target:
          </label>
          <select
            id="code-target-select"
            className="input"
            style={{ width: 'auto', maxWidth: 'min(320px, 100%)', padding: '4px 8px', fontSize: '0.78rem' }}
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
            <SquareKanban className="icon" aria-hidden /> Kanban Board
          </Link>
          <a
            href={`/api/projects/${projectId}/export.tar.gz`}
            className="btn btn-sm btn-ghost"
            title="Download workspace as .tar.gz archive"
          >
            <Package className="icon" aria-hidden /> Download .tar.gz
          </a>
        </div>
      </div>

      {Boolean(fileList.error && !fileList.data) && (
        <ViewErrorBanner
          label="Could not load workspace files"
          error={fileList.error}
          onRetry={fileList.refresh}
        />
      )}
      {error && (
        <div className="banner banner-error" role="alert" style={{ margin: 0 }}>
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="banner banner-ok" style={{ margin: 0 }}>
          {statusMessage}
        </div>
      )}

      <div className="code-explorer-grid" style={{ flex: 1, minHeight: 0, display: 'grid', gap: '10px' }}>
        <CodeExplorerTree
          projectId={projectId}
          targetId={targetId}
          allEntries={fileList.data?.entries ?? []}
          visibleEntries={visibleEntries}
          loading={fileList.loading}
          hasData={Boolean(fileList.data)}
          hasError={Boolean(fileList.error)}
          filterText={filterText}
          onFilterTextChange={setFilterText}
          collapsedDirs={collapsedDirs}
          onToggleDir={toggleDir}
          activePath={activePath}
          onOpenFile={(p) => void openFile(p)}
          onDeleteFile={(p) => void handleDeleteFile(p)}
          onRefresh={() => void fileList.refresh()}
          uploading={uploading}
          uploadTargetDir={uploadTargetDir}
          onUploadTargetDirChange={setUploadTargetDir}
          onUploadFiles={handleUploadFiles}
          onCreateFile={handleCreateFile}
        />

        <CodeExplorerStage
          projectId={projectId}
          projectSlug={project?.slug}
          targetId={targetId}
          tabs={tabs}
          activePath={activePath}
          activeTab={activeTab}
          onSelectTab={setActivePath}
          onCloseTab={closeTab}
          onChangeActiveContent={(nextVal) => {
            if (!activeTab) return;
            setTabs((prev) => prev.map((t) => (t.path === activeTab.path ? { ...t, content: nextVal } : t)));
          }}
          saving={saving}
          onSaveActiveFile={() => void saveActiveFile()}
          onDeleteFile={(p) => void handleDeleteFile(p)}
          themeMode={themeMode}
          agentPersona={agentPersona}
          onChangeAgentPersona={setAgentPersona}
          agentPrompt={agentPrompt}
          onChangeAgentPrompt={setAgentPrompt}
          dispatchingAgent={dispatchingAgent}
          onSubmitAgentPrompt={(e) => void handleAskAgentOnFile(e)}
        />
      </div>
    </div>
  );
}
