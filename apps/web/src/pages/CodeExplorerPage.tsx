import type {
  AgentPersona,
  FactoryRequestResponse,
  Project,
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
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sql':
      return 'sql';
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        { path: relPath, content: '', savedContent: '', loading: true, binary: false },
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
    const files = (fileList.data?.entries ?? []).filter((f: WorkspaceFileEntry) => f.kind === 'file');
    if (files.length === 0) return;
    const preferred =
      files.find((f: WorkspaceFileEntry) => f.path === 'index.html') ??
      files.find(
        (f: WorkspaceFileEntry) =>
          f.path === 'src/App.tsx' || f.path === 'src/main.ts' || f.path === 'src/index.ts',
      ) ??
      files.find((f: WorkspaceFileEntry) => f.path === 'PROJECT.md') ??
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
    if (!activeTab) return;
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
          t.path === activeTab.path ? { ...t, savedContent: res.content } : t,
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
          permissionMode: 'acceptEdits',
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
          gridTemplateColumns: '270px 1fr',
          gap: '10px',
        }}
      >
        {/* Left File Tree Sidebar */}
        <aside
          className="panel"
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            padding: '10px',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
            <span className="eyebrow">
              Files ({(fileList.data?.entries ?? []).filter((f: WorkspaceFileEntry) => f.kind === 'file').length})
            </span>
            <div style={{ display: 'flex', gap: '4px' }}>
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
              >
                ↻
              </button>
            </div>
          </div>

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
            placeholder="Filter files…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {visibleEntries.map((entry: WorkspaceFileEntry) => {
              const depth = entry.path.split('/').length - 1;
              const isDir = entry.kind === 'directory';
              const isCollapsed = isDir && collapsedDirs.has(entry.path);
              const isSelected = !isDir && activePath === entry.path;

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
                  }}
                  onClick={() => {
                    if (isDir) toggleDir(entry.path);
                    else void openFile(entry.path);
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
                    }}
                    title={entry.path}
                  >
                    {isDir ? (isCollapsed ? '▸ 📁 ' : '▾ 📂 ') : '📄 '}
                    {entry.name}
                  </span>
                  {!isDir && (
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

        {/* Right Monaco Editor Area */}
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
                const isDirty = tab.content !== tab.savedContent;
                const active = tab.path === activePath;
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
                    <span className="mono">{tab.path}</span>
                    {isDirty && (
                      <span style={{ color: 'var(--ember-1)', fontWeight: 700 }} title="Unsaved changes">
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
              {tabs.length === 0 && <span className="muted small">Select a file from the tree to view or edit</span>}
            </div>

            {activeTab && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className="badge mono">{detectLanguage(activeTab.path)}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={saving || activeTab.content === activeTab.savedContent}
                  onClick={() => void saveActiveFile()}
                >
                  {saving ? 'Saving…' : '💾 Save (⌘S)'}
                </button>
              </div>
            )}
          </div>

          {/* Monaco Editor Stage */}
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {activeTab ? (
              activeTab.loading ? (
                <div style={{ padding: '24px' }} className="muted mono">
                  Loading {activeTab.path}…
                </div>
              ) : activeTab.binary ? (
                <div style={{ padding: '24px' }} className="muted mono">
                  Binary file ({activeTab.path}) cannot be edited as text.
                </div>
              ) : (
                <StandaloneMonacoEditor
                  filePath={`${targetId}:${activeTab.path}`}
                  language={detectLanguage(activeTab.path)}
                  theme={isLightTheme ? 'vs' : 'vs-dark'}
                  value={activeTab.content}
                  onChange={(nextVal: string) => {
                    setTabs((prev) =>
                      prev.map((t) => (t.path === activeTab.path ? { ...t, content: nextVal } : t)),
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
                Choose a file on the left to inspect or edit code directly in `/workspaces/{project?.slug}`.
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
                placeholder={`e.g. "Refactor ${activeTab.path} to add particle effects and sound hooks"`}
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
