import type { AgentPersona } from '@emberline/protocol';
import { isWorktreeYmlPath } from '@emberline/protocol';
import { Download, Package, Rocket, Save, Sparkles, Trash2, X } from 'lucide-react';
import { type FormEvent, type MouseEvent, useMemo } from 'react';
import { Link } from 'wouter';
import { monacoTheme } from '../../monaco';
import { WORKTREE_EDIT_PARAM, worktreeYmlExplorerNote } from '../../projectSettings';
import { ErrorBoundary, ViewErrorBanner, ViewLoadingState } from '../ErrorBoundary';
import { MonacoEditor } from '../MonacoEditor';
import { PERSONA_LIST } from '../PersonaBadge';
import {
  describeFileType,
  detectLanguage,
  FileTypeIcon,
  formatBytes,
  getFileDownloadUrl,
  type OpenTab,
} from './fileTypes';

export function CodeExplorerStage({
  projectId,
  projectSlug,
  targetId,
  tabs,
  activePath,
  activeTab,
  onSelectTab,
  onCloseTab,
  onChangeActiveContent,
  saving,
  onSaveActiveFile,
  onRetryActiveFile,
  onDeleteFile,
  themeMode,
  agentPersona,
  onChangeAgentPersona,
  agentPrompt,
  onChangeAgentPrompt,
  dispatchingAgent,
  onSubmitAgentPrompt,
}: {
  projectId: string;
  projectSlug: string | undefined;
  targetId: string;
  tabs: OpenTab[];
  activePath: string | null;
  activeTab: OpenTab | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string, e: MouseEvent) => void;
  onChangeActiveContent: (nextVal: string) => void;
  saving: boolean;
  onSaveActiveFile: () => void;
  onRetryActiveFile?: (relPath: string) => void;
  onDeleteFile: (relPath: string) => void;
  themeMode: 'dark' | 'light';
  agentPersona: AgentPersona;
  onChangeAgentPersona: (persona: AgentPersona) => void;
  agentPrompt: string;
  onChangeAgentPrompt: (prompt: string) => void;
  dispatchingAgent: boolean;
  onSubmitAgentPrompt: (e: FormEvent) => void;
}) {
  const activeFileDescriptor = useMemo(
    () => (activeTab ? describeFileType(activeTab.path) : null),
    [activeTab],
  );
  const worktreeNote =
    activeTab && isWorktreeYmlPath(activeTab.path) ? worktreeYmlExplorerNote(targetId) : null;

  return (
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
                onClick={() => onSelectTab(tab.path)}
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
                <span>
                  <FileTypeIcon icon={desc.icon} />
                </span>
                <span className="mono">{tab.path}</span>
                {isDirty && (
                  <span style={{ color: 'var(--ember-1)', fontWeight: 700 }} title="Unsaved changes">
                    ●
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => onCloseTab(tab.path, e)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: '0.82rem',
                  }}
                  aria-label={`Close ${tab.path}`}
                >
                  <X className="icon" aria-hidden />
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
            {!activeTab.binary && <span className="badge mono">{detectLanguage(activeTab.path)}</span>}
            <a
              href={getFileDownloadUrl(projectId, targetId, activeTab.path)}
              download={activeTab.path.split('/').pop() ?? activeTab.path}
              className="btn btn-sm btn-ghost"
              style={{ textDecoration: 'none' }}
              title={`Download ${activeTab.path}`}
            >
              <Download className="icon" aria-hidden /> Download
            </a>
            {!activeTab.binary && !isWorktreeYmlPath(activeTab.path) && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || activeTab.content === activeTab.savedContent}
                onClick={onSaveActiveFile}
              >
                {saving ? (
                  'Saving…'
                ) : (
                  <>
                    <Save className="icon" aria-hidden /> Save (⌘S)
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflowY: 'auto' }}>
        {activeTab ? (
          activeTab.loading ? (
            <ViewLoadingState label={`Loading ${activeTab.path}…`} />
          ) : activeTab.error ? (
            <div style={{ padding: '16px' }}>
              <ViewErrorBanner
                label={`Could not load ${activeTab.path}`}
                error={activeTab.error}
                onRetry={onRetryActiveFile ? () => onRetryActiveFile(activeTab.path) : undefined}
              />
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
                  <FileTypeIcon icon={activeFileDescriptor?.icon ?? Package} />
                </div>
                <div>
                  <h3 style={{ margin: '0 0 4px 0', fontSize: '1.05rem' }}>
                    {activeTab.path.split('/').pop() ?? activeTab.path}
                  </h3>
                  <div className="muted mono small">{activeTab.path}</div>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
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
                  This file is a binary, package, or media artifact and cannot be displayed or edited as plain
                  text in the code editor. You can download it directly to your device below.
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
                    <Download className="icon" aria-hidden /> Download {activeTab.path.split('/').pop()} (
                    {formatBytes(activeTab.sizeBytes)})
                  </a>
                  {!isWorktreeYmlPath(activeTab.path) && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => onDeleteFile(activeTab.path)}
                    >
                      <Trash2 className="icon" aria-hidden /> Delete File
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {worktreeNote && (
                <p className="muted small worktree-readonly-note" style={{ margin: 0, padding: '6px 12px' }}>
                  {worktreeNote.text}{' '}
                  <Link href={`/projects/${projectId}/settings?${WORKTREE_EDIT_PARAM}`}>
                    {worktreeNote.link}
                  </Link>
                </p>
              )}
              <div style={{ flex: 1, minHeight: 0 }}>
                <ErrorBoundary resetKey={`${targetId}:${activeTab.path}`} compact>
                  <MonacoEditor
                    filePath={`${targetId}:${activeTab.path}`}
                    language={detectLanguage(activeTab.path)}
                    theme={monacoTheme(themeMode)}
                    value={activeTab.content}
                    readOnly={isWorktreeYmlPath(activeTab.path)}
                    onChange={onChangeActiveContent}
                  />
                </ErrorBoundary>
              </div>
            </div>
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
            {projectSlug}`.
          </div>
        )}
      </div>

      {activeTab && (
        <form
          onSubmit={onSubmitAgentPrompt}
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
            <Sparkles className="icon" aria-hidden /> Ask Agent on `{activeTab.path}`:
          </span>
          <select
            className="input"
            style={{
              width: 'auto',
              maxWidth: 'min(320px, 100%)',
              padding: '4px 8px',
              fontSize: '0.76rem',
            }}
            value={agentPersona}
            onChange={(e) => onChangeAgentPersona(e.target.value as AgentPersona)}
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
            onChange={(e) => onChangeAgentPrompt(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={dispatchingAgent || !agentPrompt.trim()}
          >
            {dispatchingAgent ? (
              'Dispatching…'
            ) : (
              <>
                <Rocket className="icon" aria-hidden /> Dispatch to Agent
              </>
            )}
          </button>
        </form>
      )}
    </section>
  );
}
