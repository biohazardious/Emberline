import type { AgentPersona } from '@emberline/protocol';
import { isWorktreeYmlPath } from '@emberline/protocol';
import { Download, Package, Rocket, Save, Trash2, Undo2, X } from 'lucide-react';
import { type FormEvent, type MouseEvent, useMemo } from 'react';
import { Link } from 'wouter';
import { monacoTheme } from '../../monaco';
import { WORKTREE_EDIT_PARAM, worktreeYmlExplorerNote } from '../../projectSettings';
import { ErrorBoundary, ViewErrorBanner, ViewLoadingState } from '../ErrorBoundary';
import { MonacoEditor } from '../MonacoEditor';
import { PERSONA_LIST } from '../PersonaBadge';
import { Disclosure } from '../ui/Disclosure';
import { HelpHint } from '../ui/HelpHint';
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
  onRevertActiveFile,
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
  onRevertActiveFile?: () => void;
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
  const activeDirty = Boolean(activeTab && !activeTab.binary && activeTab.content !== activeTab.savedContent);
  const activeStateLine = activeTab
    ? activeTab.binary
      ? `${activeFileDescriptor?.label ?? 'Binary file'} · ${formatBytes(activeTab.sizeBytes)}`
      : `${detectLanguage(activeTab.path)} · ${formatBytes(activeTab.sizeBytes)}${
          isWorktreeYmlPath(activeTab.path) ? ' · Read-only' : activeDirty ? ' · Unsaved changes' : ' · Saved'
        }`
    : '';

  return (
    <section className="panel code-stage-panel">
      {tabs.length > 0 && (
        <div className="code-stage-tabs-bar">
          {tabs.map((tab) => {
            const isDirty = !tab.binary && tab.content !== tab.savedContent;
            const active = tab.path === activePath;
            const desc = describeFileType(tab.path);
            return (
              <div
                key={tab.path}
                className={`code-stage-tab${active ? ' code-stage-tab-active' : ''}`}
                onClick={() => onSelectTab(tab.path)}
              >
                <span>
                  <FileTypeIcon icon={desc.icon} />
                </span>
                <span className="mono">{tab.path}</span>
                {isDirty && (
                  <span className="code-stage-tab-dirty" aria-label="Unsaved changes">
                    ●
                  </span>
                )}
                <button
                  type="button"
                  className="code-stage-tab-close"
                  onClick={(e) => onCloseTab(tab.path, e)}
                  aria-label={`Close ${tab.path}`}
                >
                  <X className="icon" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {activeTab && (
        <div className="code-stage-header">
          <div className="code-stage-file-info">
            <span className="mono code-stage-filepath">{activeTab.path}</span>
            <span className="muted code-stage-stateline">{activeStateLine}</span>
          </div>

          <div className="code-stage-actions">
            {activeDirty && onRevertActiveFile && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={saving}
                onClick={onRevertActiveFile}
              >
                <Undo2 className="icon" aria-hidden /> Discard
              </button>
            )}
            <a
              href={getFileDownloadUrl(projectId, targetId, activeTab.path)}
              download={activeTab.path.split('/').pop() ?? activeTab.path}
              className="btn btn-sm btn-ghost code-stage-download-link"
            >
              <Download className="icon" aria-hidden /> Download
            </a>
            {!activeTab.binary && !isWorktreeYmlPath(activeTab.path) && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || !activeDirty}
                onClick={onSaveActiveFile}
              >
                {saving ? (
                  'Saving…'
                ) : (
                  <>
                    <Save className="icon" aria-hidden /> Save
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="code-stage-body">
        {activeTab ? (
          activeTab.loading ? (
            <ViewLoadingState label={`Loading ${activeTab.path}…`} />
          ) : activeTab.error ? (
            <div className="code-stage-error-wrap">
              <ViewErrorBanner
                label={`Could not load ${activeTab.path}`}
                error={activeTab.error}
                onRetry={onRetryActiveFile ? () => onRetryActiveFile(activeTab.path) : undefined}
              />
            </div>
          ) : activeTab.binary ? (
            <div className="code-stage-binary-wrap">
              <div className="panel code-stage-binary-card">
                <div className="code-stage-binary-icon">
                  <FileTypeIcon icon={activeFileDescriptor?.icon ?? Package} />
                </div>
                <div>
                  <h2 className="code-stage-binary-title">
                    {activeTab.path.split('/').pop() ?? activeTab.path}
                  </h2>
                  <div className="muted mono small">{activeTab.path}</div>
                </div>

                <div className="code-stage-binary-badges">
                  <span className="badge badge-soft">
                    {activeFileDescriptor?.label ?? 'Binary / Non-Text File'}
                  </span>
                  <span className="badge mono">{formatBytes(activeTab.sizeBytes)}</span>
                </div>

                {activeFileDescriptor?.previewKind === 'image' && (
                  <div className="code-stage-media-box">
                    <img
                      src={getFileDownloadUrl(projectId, targetId, activeTab.path, true)}
                      alt={activeTab.path}
                      className="code-stage-media-img"
                    />
                  </div>
                )}

                {activeFileDescriptor?.previewKind === 'audio' && (
                  <audio
                    controls
                    src={getFileDownloadUrl(projectId, targetId, activeTab.path, true)}
                    className="code-stage-media-audio"
                  />
                )}

                {activeFileDescriptor?.previewKind === 'video' && (
                  <video
                    controls
                    src={getFileDownloadUrl(projectId, targetId, activeTab.path, true)}
                    className="code-stage-media-video"
                  />
                )}

                <p className="muted small code-stage-binary-note">
                  Binary and media files cannot be edited as plain text.
                </p>

                <div className="code-stage-binary-actions">
                  <a
                    href={getFileDownloadUrl(projectId, targetId, activeTab.path)}
                    download={activeTab.path.split('/').pop() ?? activeTab.path}
                    className="btn btn-primary code-stage-download-link"
                  >
                    <Download className="icon" aria-hidden /> Download file
                  </a>
                  {!isWorktreeYmlPath(activeTab.path) && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => onDeleteFile(activeTab.path)}
                    >
                      <Trash2 className="icon" aria-hidden /> Delete file
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="code-stage-editor-col">
              {worktreeNote && (
                <p className="muted small worktree-readonly-note">
                  {worktreeNote.text}{' '}
                  <Link href={`/projects/${projectId}/settings?${WORKTREE_EDIT_PARAM}`}>
                    {worktreeNote.link}
                  </Link>
                </p>
              )}
              <div className="code-stage-editor-wrap">
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
          <div className="code-stage-empty">
            <p className="code-stage-empty-line">Select a file from the tree to view or edit.</p>
            <HelpHint topic="code editor">
              Open any file in <span className="mono">/workspaces/{projectSlug ?? projectId}</span> to edit
              and save with Ctrl+S / ⌘S, preview media, or drop files onto the tree to upload.
            </HelpHint>
          </div>
        )}
      </div>

      {activeTab && (
        <div className="code-stage-footer">
          <Disclosure label="Ask agent">
            <form onSubmit={onSubmitAgentPrompt} className="code-stage-agent-form">
              <select
                className="input code-stage-agent-select"
                aria-label="Agent persona"
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
                className="input code-stage-agent-input"
                aria-label={`Task for ${activeTab.path}`}
                placeholder={`Describe changes for ${activeTab.path}…`}
                value={agentPrompt}
                onChange={(e) => onChangeAgentPrompt(e.target.value)}
              />
              <button type="submit" className="btn btn-sm" disabled={dispatchingAgent || !agentPrompt.trim()}>
                {dispatchingAgent ? (
                  'Dispatching…'
                ) : (
                  <>
                    <Rocket className="icon" aria-hidden /> Ask agent
                  </>
                )}
              </button>
            </form>
          </Disclosure>
        </div>
      )}
    </section>
  );
}
