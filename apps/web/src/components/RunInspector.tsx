import type { Run, RunDetail, RunEvent } from '@emberline/protocol';
import { Globe, KeyRound, Maximize2, TriangleAlert, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { timeAgo } from '../time';
import { HandoffMenu } from './QuotaLanes';
import { BuildOutputsList, ExpandableText, FinalAnswer, LastScreen } from './RunOutcome';
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
    hint: 'Ask the agent to inspect the codebase and propose a plan first',
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

export function formatAgentDisplayName(agent?: string | null): string {
  switch (agent) {
    case 'antigravity':
      return 'Google Antigravity (agy)';
    case 'gemini':
      return 'Google Gemini';
    case 'codex':
      return 'OpenAI Codex';
    case 'copilot':
      return 'GitHub Copilot';
    case 'aider':
      return 'Aider';
    default:
      return 'Claude';
  }
}

export function formatAgentResumePlaceholder(agent?: string | null): string {
  switch (agent) {
    case 'antigravity':
      return 'Continue the ended session (agy --continue)…';
    case 'gemini':
      return 'Continue the ended session (gemini)…';
    case 'codex':
      return 'Continue the ended session (codex)…';
    case 'copilot':
      return 'Continue the ended session (copilot)…';
    case 'aider':
      return 'Continue the ended session (aider)…';
    default:
      return 'Continue the ended session (claude --resume)…';
  }
}

function payloadSummary(payload: unknown): { tool?: string; detail?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const rec = payload as Record<string, unknown>;
  const tool = typeof rec.tool_name === 'string' ? rec.tool_name : undefined;
  const exitPrefix =
    typeof rec.exitCode === 'number' && rec.exitCode !== 0 ? `Exit code ${rec.exitCode}` : undefined;
  const msg =
    (typeof rec.tool_input_summary === 'string' && rec.tool_input_summary) ||
    (typeof rec.message === 'string' && rec.message) ||
    (typeof rec.error_details === 'string' && rec.error_details) ||
    (typeof rec.last_assistant_message === 'string' && rec.last_assistant_message) ||
    (typeof rec.reason === 'string' && rec.reason) ||
    (typeof rec.error === 'string' && rec.error) ||
    undefined;
  const detail = exitPrefix && msg ? `${exitPrefix}: ${msg}` : msg || exitPrefix;
  return { tool, detail };
}

export function extractFailureDetails(events: RunEvent[], agent?: string | null): {
  reason: string;
  exitCode?: number;
  needsAuth: boolean;
} {
  let reason = '';
  let exitCode: number | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || !ev.payload || typeof ev.payload !== 'object') continue;
    const rec = ev.payload as Record<string, unknown>;
    if (typeof rec.exitCode === 'number' && exitCode === undefined) {
      exitCode = rec.exitCode;
    }
    if (!reason) {
      const candidate =
        (typeof rec.message === 'string' && rec.message) ||
        (typeof rec.error_details === 'string' && rec.error_details) ||
        (typeof rec.reason === 'string' && rec.reason) ||
        (typeof rec.error === 'string' && rec.error !== 'cli_exit' ? rec.error : '');
      if (candidate) {
        reason = candidate;
      }
    }
  }
  const lower = reason.toLowerCase();
  const needsAuth =
    exitCode === 41 ||
    lower.includes('api_key') ||
    lower.includes('api key') ||
    lower.includes('not authenticated') ||
    lower.includes('authentication') ||
    lower.includes('login') ||
    lower.includes('oauth') ||
    lower.includes('credentials');

  if (!reason || reason === `${agent ?? 'Agent'} exited with non-zero code`) {
    if (exitCode === 41) {
      reason = `${formatAgentDisplayName(agent)} exited with code 41 (Authentication / API Key required). Open Factory Settings to sign in via Console Login or save your API key.`;
    } else if (exitCode !== undefined) {
      reason = `${formatAgentDisplayName(agent)} process exited unexpectedly with exit code ${exitCode}.`;
    } else {
      reason = `${formatAgentDisplayName(agent)} execution failed.`;
    }
  }
  return { reason, exitCode, needsAuth };
}

export function RunFailureBanner({ run }: { run: Run }) {
  const [detail, setDetail] = useState<RunDetail>();

  useEffect(() => {
    if (run.state !== 'failed') return;
    let cancelled = false;
    void api<RunDetail>(`/api/runs/${run.id}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [run.id, run.state, run.stateChangedAt]);

  if (run.state !== 'failed') return null;

  const { reason, exitCode, needsAuth } = extractFailureDetails(detail?.events ?? [], run.agent);

  return (
    <div
      className="run-failure-banner"
      role="alert"
      style={{
        background: 'color-mix(in srgb, var(--bad) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--bad) 35%, transparent)',
        borderRadius: '8px',
        padding: '10px 12px',
        marginBottom: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--bad)', fontSize: '0.85rem' }}>
          <TriangleAlert className="icon" aria-hidden /> {formatAgentDisplayName(run.agent)} Run Failed
          {exitCode !== undefined ? ` (exit code ${exitCode})` : ''}
        </strong>
        {needsAuth && (
          <Link href="/settings" className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}>
            <KeyRound className="icon" aria-hidden /> Configure Auth & Keys →
          </Link>
        )}
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: '0.78rem',
          color: 'var(--bad)',
          background: 'var(--surface-2)',
          padding: '6px 8px',
          borderRadius: '6px',
          maxHeight: '120px',
          overflowY: 'auto',
        }}
      >
        {reason}
      </pre>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  handed_off: 'handed off',
  handoff_from: 'took over',
  route_bound: 'fallback route',
  route_skipped: 'route skipped',
  handoff_failed: 'handoff failed',
  rate_limit_failed: 'limit reached',
  retry_scheduled: 'retry scheduled',
  retry_gave_up: 'retry gave up',
};

/** The other run of a handoff, for `handed_off` (successor) and `handoff_from` (predecessor) events. */
function handoffTarget(ev: RunEvent): string | undefined {
  const payload = ev.payload as { toRunId?: unknown; fromRunId?: unknown } | null;
  const id = ev.type === 'handed_off' ? payload?.toRunId : ev.type === 'handoff_from' ? payload?.fromRunId : undefined;
  return typeof id === 'string' ? id : undefined;
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

  // The saved last screen is shown on its own above the timeline, not as an entry in it.
  const events: RunEvent[] = (detail?.events ?? []).filter((e) => e.type !== 'last_screen');

  if (loading && events.length === 0) {
    return <p className="muted small">Loading activity timeline…</p>;
  }

  if (events.length === 0) {
    return <p className="muted small">No events recorded yet.</p>;
  }

  return (
    <>
      {detail?.finalMessage && (run.state === 'done' || run.state === 'failed' || run.endedAt) && (
        <FinalAnswer text={detail.finalMessage} />
      )}
      <BuildOutputsList runId={run.id} refreshKey={run.stateChangedAt} />
      {detail?.lastScreen && !run.terminalId && <LastScreen text={detail.lastScreen} />}
      <ol className="event-timeline" aria-label="Agent event timeline">
      {[...events].reverse().map((ev) => {
        const { tool, detail: text } = payloadSummary(ev.payload);
        return (
          <li key={ev.id} className={`event-item event-src-${ev.source}`}>
            <div className="event-head">
              <span className="event-source mono">{ev.source}</span>
              <span className="event-type mono">{EVENT_LABEL[ev.type] ?? ev.type}</span>
              {handoffTarget(ev) && (
                <Link href={`/runs/${handoffTarget(ev)}/review`} className="badge badge-soft mono">
                  run {handoffTarget(ev)?.slice(0, 8)} →
                </Link>
              )}
              {tool && <span className="badge badge-soft mono">{tool}</span>}
              {ev.state && <RunStatePill state={ev.state} />}
              <span className="event-time mono">{timeAgo(ev.ts)}</span>
            </div>
            {text && <ExpandableText text={text} />}
          </li>
        );
      })}
      </ol>
    </>
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
          <RunStatePill state={run.state} cancelled={run.cancelled} autoRetry={run.autoRetry} handedOffTo={run.handedOffTo} />
          <strong className="dock-title">{run.title ?? projectName ?? 'Agent Run'}</strong>
          {run.branch && <span className="badge badge-soft mono">{run.branch}</span>}
          <span className="badge mono">{run.permissionMode}</span>
        </div>
        <HandoffMenu run={run} />
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
          <Link
            href={`/projects/${run.projectId}/browser`}
            className="btn btn-sm btn-ghost"
            title="Watch shared Live Browser Studio"
          >
            <Globe className="icon" aria-hidden /> Live Browser
          </Link>
          {run.worktreePath && (
            <Link href={`/runs/${run.id}/review`} className="btn btn-sm btn-ghost" title="Open Diff & Review workspace">
              Diff & Review
            </Link>
          )}
          {run.terminalId && (
            <Link href={`/terminals/${run.terminalId}`} className="btn btn-sm btn-ghost" title="Open full-page terminal">
              <Maximize2 className="icon" aria-hidden />
            </Link>
          )}
          <button type="button" className="icon-btn" aria-label="Close inspector" onClick={onClose}>
            <X className="icon" aria-hidden />
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
            <RunFailureBanner run={run} />
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
