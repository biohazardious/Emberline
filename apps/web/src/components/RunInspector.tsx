import type { Run, RunDetail, RunEvent } from '@emberline/protocol';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { timeAgo } from '../time';
import { RunStatePill } from './RunStatePill';

const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

export interface StageTemplate {
  id: string;
  label: string;
  hint: string;
  prompt: string;
}

/** Pipeline stage prompt templates inspired by herdr-board & Omnigent critic flows. */
export const STAGE_TEMPLATES: StageTemplate[] = [
  {
    id: 'plan',
    label: 'Plan & Scope',
    hint: 'Ask Claude to inspect the codebase and propose a plan first',
    prompt:
      'Analyze the task and relevant files first. Propose a concise step-by-step implementation plan and list the files to touch before making code changes.',
  },
  {
    id: 'implement',
    label: 'Implement',
    hint: 'Execute the planned changes cleanly',
    prompt:
      'Proceed with the implementation. Follow existing codebase conventions, keep edits minimal and focused, and verify compilation.',
  },
  {
    id: 'verify',
    label: 'Verify & Test',
    hint: 'Run tests, typecheck, and fix any failures',
    prompt: 'Run the relevant tests, typecheck, and linter. Fix any failures or regressions you uncover.',
  },
  {
    id: 'review',
    label: 'Self-Review',
    hint: 'Critic pass over git diff before accepting',
    prompt:
      'Review your git diff critically for edge cases, security issues, or unintended changes. Fix anything questionable and summarize what was done.',
  },
];

function payloadSummary(payload: unknown): { tool?: string; detail?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const rec = payload as Record<string, unknown>;
  const tool = typeof rec.tool_name === 'string' ? rec.tool_name : undefined;
  const detail =
    (typeof rec.message === 'string' && rec.message) ||
    (typeof rec.error_details === 'string' && rec.error_details) ||
    (typeof rec.error === 'string' && rec.error) ||
    (typeof rec.last_assistant_message === 'string' && rec.last_assistant_message) ||
    (typeof rec.reason === 'string' && rec.reason) ||
    undefined;
  return { tool, detail };
}

export function RunEventTimeline({ run }: { run: Run }) {
  const [detail, setDetail] = useState<RunDetail>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<RunDetail>(`/api/runs/${run.id}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run.id, run.state, run.stateChangedAt, run.lastEvent]);

  const events: RunEvent[] = detail?.events ?? [];

  if (loading && events.length === 0) {
    return <p className="muted small">Loading activity timeline…</p>;
  }

  if (events.length === 0) {
    return <p className="muted small">No events recorded yet.</p>;
  }

  return (
    <ol className="event-timeline" aria-label="Agent event timeline">
      {[...events].reverse().map((ev) => {
        const { tool, detail: text } = payloadSummary(ev.payload);
        return (
          <li key={ev.id} className={`event-item event-src-${ev.source}`}>
            <div className="event-head">
              <span className="event-source mono">{ev.source}</span>
              <span className="event-type mono">{ev.type}</span>
              {tool && <span className="badge badge-soft mono">{tool}</span>}
              {ev.state && <RunStatePill state={ev.state} />}
              <span className="event-time mono">{timeAgo(ev.ts)}</span>
            </div>
            {text && <p className="event-detail mono">{text}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export function RunInspector({
  run,
  projectName,
  onClose,
}: {
  run: Run;
  projectName: string | undefined;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'split' | 'terminal' | 'timeline'>(run.terminalId ? 'split' : 'timeline');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const live = !run.endedAt;
  const canPrompt = (live && run.state !== 'queued') || run.resumable;

  useEffect(() => {
    if (!run.terminalId && tab === 'terminal') setTab('timeline');
  }, [run.terminalId, tab]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const sendPrompt = (textToSend?: string) => {
    const value = (textToSend ?? prompt).trim();
    if (!value) return;
    void act('send', async () => {
      await api(`/api/runs/${run.id}/prompt`, 'POST', { text: value });
      if (!textToSend) setPrompt('');
    });
  };

  return (
    <aside className="dock-inspector" aria-label="Run inspector">
      <header className="dock-head">
        <div className="dock-head-main">
          <RunStatePill state={run.state} />
          <strong className="dock-title">{run.title ?? projectName ?? 'Agent Run'}</strong>
          {run.branch && <span className="badge badge-soft mono">{run.branch}</span>}
          <span className="badge mono">{run.permissionMode}</span>
        </div>
        <div className="dock-head-actions">
          <div className="segmented" role="tablist" aria-label="Inspector view">
            {run.terminalId && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'split'}
                className={tab === 'split' ? 'active' : ''}
                onClick={() => setTab('split')}
              >
                Split
              </button>
            )}
            {run.terminalId && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'terminal'}
                className={tab === 'terminal' ? 'active' : ''}
                onClick={() => setTab('terminal')}
              >
                Terminal
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'timeline'}
              className={tab === 'timeline' ? 'active' : ''}
              onClick={() => setTab('timeline')}
            >
              Events
            </button>
          </div>
          {run.worktreePath && (
            <Link href={`/runs/${run.id}/review`} className="btn btn-sm btn-ghost" title="Open Diff & Review workspace">
              Diff & Review
            </Link>
          )}
          {run.terminalId && (
            <Link href={`/terminals/${run.terminalId}`} className="btn btn-sm btn-ghost" title="Open full-page terminal">
              ↗
            </Link>
          )}
          <button type="button" className="icon-btn" aria-label="Close inspector" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      <div className={`dock-body dock-body-${tab}`}>
        {run.terminalId && (tab === 'split' || tab === 'terminal') && (
          <div className="dock-term-pane">
            <Suspense fallback={<div className="term-shell term-shell-compact" aria-busy="true" />}>
              <TerminalView key={run.terminalId} terminalId={run.terminalId} compact />
            </Suspense>
          </div>
        )}
        {(tab === 'split' || tab === 'timeline' || !run.terminalId) && (
          <div className="dock-events-pane">
            <div className="dock-section-head">
              <span className="eyebrow">Hook & Activity Stream</span>
              <span className="muted small mono">{run.lastEvent ?? 'idle'}</span>
            </div>
            <RunEventTimeline run={run} />
          </div>
        )}
      </div>

      <footer className="dock-foot">
        {canPrompt && (
          <>
            <div className="template-bar" aria-label="Stage prompt templates">
              <span className="template-label mono">Stage:</span>
              {STAGE_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className="chip-btn"
                  title={tpl.hint}
                  disabled={!!busy}
                  onClick={() => setPrompt(tpl.prompt)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
            <div className="dock-prompt-row">
              <textarea
                className="input"
                rows={2}
                placeholder={
                  !live
                    ? 'Continue ended session (claude --resume)…'
                    : run.state === 'waiting_input'
                      ? 'Reply to Claude…'
                      : 'Send follow-up instruction (⌘+Enter)…'
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) {
                    e.preventDefault();
                    sendPrompt();
                  }
                }}
              />
              <div className="dock-prompt-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!prompt.trim() || !!busy}
                  onClick={() => sendPrompt()}
                >
                  {busy === 'send' ? 'Sending…' : live ? 'Send' : 'Resume'}
                </button>
                {(run.state === 'rate_limited' || run.resumable) && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!!busy}
                    onClick={() => void act('resume', () => api(`/api/runs/${run.id}/resume`, 'POST', {}))}
                  >
                    Resume now
                  </button>
                )}
                {live && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost danger"
                    disabled={!!busy}
                    onClick={() => void act('stop', () => api(`/api/runs/${run.id}/stop`, 'POST'))}
                  >
                    {run.state === 'queued' ? 'Cancel' : 'Stop'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        {!canPrompt && live && (
          <div className="agent-note">
            <span>Queued: waiting for a free slot and available quota.</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={!!busy}
              onClick={() => void act('stop', () => api(`/api/runs/${run.id}/stop`, 'POST'))}
            >
              Cancel
            </button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
      </footer>
    </aside>
  );
}
