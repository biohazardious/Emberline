import type { Run } from '@emberline/protocol';
import { Globe, Maximize2, Square, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { HANDOFF_STATES } from '../handoffCandidates';
import { HoldRecovery, useHoldAnswer } from './HoldRecovery';
import { HandoffMenu } from './QuotaLanes';
import { RunStatePill } from './RunStatePill';
import { RunEventTimeline } from './runInspector/RunEventTimeline';
import { RunFailureBanner } from './runInspector/RunFailureBanner';
import {
  extractFailureDetails,
  failureFetchNeeded,
  formatAgentDisplayName,
  formatAgentResumePlaceholder,
  handoffTarget,
  payloadSummary,
  STAGE_TEMPLATES,
  type StageTemplate,
} from './runInspector/runInspectorMeta';
import { Disclosure } from './ui/Disclosure';
import { MoreMenu, type MoreMenuItem } from './ui/MoreMenu';
import './runInspector/run-inspector.css';

const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

export {
  extractFailureDetails,
  failureFetchNeeded,
  formatAgentDisplayName,
  formatAgentResumePlaceholder,
  handoffTarget,
  payloadSummary,
  RunEventTimeline,
  RunFailureBanner,
  STAGE_TEMPLATES,
  type StageTemplate,
};

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
  // The hold block's Answer dialog lives here, not in the Events pane: the Terminal tab unmounts that
  // pane, and the dialog with the person's files must stay until they close it.
  const holdAnswer = useHoldAnswer(run);

  const live = !run.endedAt;
  const canPrompt = (live && run.state !== 'queued') || run.resumable;
  const showHandoff = !run.handedOffTo && !run.cancelled && HANDOFF_STATES.has(run.state);

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

  const moreItems: MoreMenuItem[] = [
    {
      id: 'browser',
      label: 'Open browser',
      description: run.branch ? `Branch: ${run.branch}` : `Mode: ${run.permissionMode}`,
      icon: <Globe className="icon" aria-hidden />,
      href: `/projects/${run.projectId}/browser`,
    },
  ];
  if (run.worktreePath) {
    moreItems.push({
      id: 'review',
      label: 'Open review',
      href: `/runs/${run.id}/review`,
    });
  }
  if (run.terminalId) {
    moreItems.push({
      id: 'terminal',
      label: 'Open terminal',
      icon: <Maximize2 className="icon" aria-hidden />,
      href: `/terminals/${run.terminalId}`,
    });
  }
  if (live) {
    moreItems.push({
      id: 'stop',
      label: run.state === 'queued' ? 'Cancel run' : 'Stop run',
      icon: <Square className="icon" aria-hidden />,
      danger: true,
      disabled: !!busy,
      onSelect: () => void act('stop', () => api(`/api/runs/${run.id}/stop`, 'POST')),
    });
  }

  return (
    <aside className="dock-inspector" aria-label="Run inspector">
      <header className="dock-head">
        <div className="dock-head-main">
          <RunStatePill
            state={run.state}
            cancelled={run.cancelled}
            autoRetry={run.autoRetry}
            handedOffTo={run.handedOffTo}
          />
          <strong className="dock-title">{run.title ?? projectName ?? 'Agent run'}</strong>
        </div>
        <div className="dock-head-actions">
          {run.terminalId && (
            <div className="segmented" role="tablist" aria-label="Inspector view">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'split'}
                className={tab === 'split' ? 'active' : ''}
                onClick={() => setTab('split')}
              >
                Split
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'terminal'}
                className={tab === 'terminal' ? 'active' : ''}
                onClick={() => setTab('terminal')}
              >
                Terminal
              </button>
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
          )}
          {run.worktreePath ? (
            <Link href={`/runs/${run.id}/review`} className="btn btn-sm">
              Open review
            </Link>
          ) : run.state === 'rate_limited' ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() => void act('resume', () => api(`/api/runs/${run.id}/resume`, 'POST', {}))}
            >
              Resume
            </button>
          ) : null}
          <MoreMenu items={moreItems} ariaLabel="Inspector actions" />
          <button type="button" className="icon-btn" aria-label="Close inspector" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </div>
      </header>

      {holdAnswer.dialog}
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
            <RunFailureBanner run={run} />
            <HoldRecovery key={run.id} run={run} onAnswer={holdAnswer.open} />
            <section className="dock-section" aria-label="Handoff">
              <Disclosure label="Handoff">
                {showHandoff ? (
                  <HandoffMenu run={run} />
                ) : run.handedOffTo ? (
                  <p className="muted small">
                    Continued in{' '}
                    <Link href={`/runs/${run.handedOffTo}/review`} className="mono">
                      {run.handedOffTo.slice(0, 8)}
                    </Link>
                    .
                  </p>
                ) : (
                  <p className="muted small">
                    Route: <span className="mono">{formatAgentDisplayName(run.agent)}</span>
                    {run.model ? ` · ${run.model}` : ''}. Handoff is available when a run is waiting, paused,
                    or failed.
                  </p>
                )}
              </Disclosure>
            </section>
            <RunEventTimeline run={run} />
          </div>
        )}
      </div>

      <footer className="dock-foot">
        {canPrompt && (
          <>
            <Disclosure label="Templates">
              <div className="template-bar" aria-label="Stage prompt templates">
                {STAGE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="chip-btn"
                    disabled={!!busy}
                    onClick={() => setPrompt(tpl.prompt)}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </Disclosure>
            <div className="dock-prompt-row">
              <textarea
                className="input"
                rows={2}
                placeholder={
                  !live
                    ? formatAgentResumePlaceholder(run.agent)
                    : run.state === 'waiting_input'
                      ? `Reply to ${formatAgentDisplayName(run.agent)}…`
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
                {live ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!prompt.trim() || !!busy}
                    onClick={() => sendPrompt()}
                  >
                    {busy === 'send' ? 'Sending…' : 'Send'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!!busy}
                    onClick={() =>
                      prompt.trim()
                        ? sendPrompt()
                        : void act('resume', () => api(`/api/runs/${run.id}/resume`, 'POST', {}))
                    }
                  >
                    {busy === 'send' || busy === 'resume' ? 'Resuming…' : 'Resume'}
                  </button>
                )}
                {live && run.state === 'rate_limited' && (
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
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </footer>
    </aside>
  );
}
