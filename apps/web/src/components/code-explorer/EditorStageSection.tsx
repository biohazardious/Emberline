import type { AgentPersona, FactoryRequestResponse } from '@emberline/protocol';
import { isWorktreeYmlPath } from '@emberline/protocol';
import { Download, Rocket, Save, Sparkles, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../../api';
import { useThemeMode } from '../../hooks/useThemeMode';
import { monacoTheme } from '../../monaco';
import { WORKTREE_EDIT_PARAM, worktreeYmlExplorerNote } from '../../projectSettings';
import { MonacoEditor } from '../MonacoEditor';
import { PERSONA_BY_ID, PERSONA_LIST } from '../PersonaBadge';
import { ico } from '../SectionState';
import { BinaryFileInspector } from './BinaryFileInspector';
import {
  CE_CENTER,
  describeFileType,
  detectLanguage,
  type ExplorerCtx,
  formatBytes,
  getFileDownloadUrl,
} from './fileTypes';

export function EditorStageSection({ ctx }: { ctx: ExplorerCtx }) {
  const {
    pid,
    proj: project,
    tid,
    tabs,
    active: activePath,
    tab: activeTab,
    saving,
    selTab,
    closeTab,
    editTab,
    save,
    open,
    setErr,
    setMsg,
  } = ctx;
  const themeMode = useThemeMode();
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentPersona, setAgentPersona] = useState<AgentPersona>('coder');
  const [dispatchingAgent, setDispatchingAgent] = useState(false);

  const worktreeNote = activeTab && isWorktreeYmlPath(activeTab.path) ? worktreeYmlExplorerNote(tid) : null;

  const handleAskAgentOnFile = async (e: FormEvent) => {
    e.preventDefault();
    if (!agentPrompt.trim() || !activeTab) return;
    setDispatchingAgent(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await api<FactoryRequestResponse>(`/api/projects/${pid}/factory-request`, 'POST', {
        prompt: `Target File: \`${activeTab.path}\`\n\nTask: ${agentPrompt.trim()}`,
        leadPersona: agentPersona,
        permissionMode: 'auto',
        autoDispatch: true,
      });
      setAgentPrompt('');
      setMsg(`Dispatched ${res.ticket.key} (${PERSONA_BY_ID[agentPersona].label}) for ${activeTab.path}`);
    } catch (err) {
      setErr(errorMessage(err));
    } finally {
      setDispatchingAgent(false);
    }
  };

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
                onClick={() => selTab(tab.path)}
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
                <span>{ico(desc.icon)}</span>
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
                  aria-label={`Close ${tab.path}`}
                >
                  {ico(X)}
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
              href={getFileDownloadUrl(pid, tid, activeTab.path)}
              download={activeTab.path.split('/').pop() ?? activeTab.path}
              className="btn btn-sm btn-ghost"
              style={{ textDecoration: 'none' }}
              title={`Download ${activeTab.path}`}
            >
              {ico(Download)} Download
            </a>
            {!activeTab.binary && !isWorktreeYmlPath(activeTab.path) && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || activeTab.content === activeTab.savedContent}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : <>{ico(Save)} Save (⌘S)</>}
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflowY: 'auto' }}>
        {activeTab ? (
          activeTab.loading ? (
            <div style={{ padding: '24px' }} className="muted mono" aria-busy="true">
              Loading {activeTab.path}…
            </div>
          ) : activeTab.error ? (
            <div style={{ padding: '24px' }}>
              <p className="form-error" role="alert">
                Could not load {activeTab.path}: {activeTab.error}{' '}
                <button type="button" className="btn btn-sm" onClick={() => void open(activeTab.path)}>
                  Retry
                </button>
              </p>
            </div>
          ) : activeTab.binary ? (
            <BinaryFileInspector ctx={ctx} tab={activeTab} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {worktreeNote && (
                <p className="muted small worktree-readonly-note" style={{ margin: 0, padding: '6px 12px' }}>
                  {worktreeNote.text}{' '}
                  <Link href={`/projects/${pid}/settings?${WORKTREE_EDIT_PARAM}`}>{worktreeNote.link}</Link>
                </p>
              )}
              <div style={{ flex: 1, minHeight: 0 }}>
                <MonacoEditor
                  filePath={`${tid}:${activeTab.path}`}
                  language={detectLanguage(activeTab.path)}
                  theme={monacoTheme(themeMode)}
                  value={activeTab.content}
                  readOnly={isWorktreeYmlPath(activeTab.path)}
                  onChange={(nextVal: string) => editTab(activeTab.path, nextVal)}
                />
              </div>
            </div>
          )
        ) : (
          <div style={{ ...CE_CENTER, color: 'var(--muted)' }}>
            Choose a file on the left to inspect, download, or edit directly in `/workspaces/{project?.slug}`.
          </div>
        )}
      </div>

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
            {ico(Sparkles)} Ask Agent on `{activeTab.path}`:
          </span>
          <select
            className="input"
            style={{ width: 'auto', maxWidth: 'min(320px, 100%)', padding: '4px 8px', fontSize: '0.76rem' }}
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
            {dispatchingAgent ? 'Dispatching…' : <>{ico(Rocket)} Dispatch to Agent</>}
          </button>
        </form>
      )}
    </section>
  );
}
