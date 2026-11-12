import type { Run } from '@emberline/protocol';
import { Link } from 'wouter';
import { useRuns } from '../../hooks/liveData';
import { overlapWaitingFor, overlapWaitingLabel } from '../../ticketDeps';
import { HoldRecovery } from '../HoldRecovery';
import { modeHint, PermissionModePicker } from '../PermissionModePicker';
import { HandoffMenu } from '../QuotaLanes';
import {
  formatAgentDisplayName,
  formatAgentResumePlaceholder,
  RunFailureBanner,
  STAGE_TEMPLATES,
} from '../RunInspector';
import { BuildOutputsList } from '../RunOutcome';
import { RunStatePill } from '../RunStatePill';
import type { DrawerCtx } from './boardMeta';

/** The runs that came before `run` in its handoff chain (oldest first); the same attempt continued on other routes. */
function AttemptChain({ run }: { run: Run }) {
  const { runs } = useRuns();
  const chain: { id: string; run?: Run }[] = [];
  const seen = new Set([run.id]);
  for (let id = run.predecessorRunId; id && !seen.has(id);) {
    seen.add(id);
    const found = (runs ?? []).find((r) => r.id === id);
    chain.unshift({ id, run: found });
    id = found?.predecessorRunId ?? null;
  }
  if (chain.length === 0) return null;
  return (
    <div className="attempt-chain muted small">
      <span>Earlier on this attempt</span>
      <ol>
        {chain.map(({ id, run: p }) => (
          <li key={id}>
            {p ? (
              <>
                <span className="mono">
                  {formatAgentDisplayName(p.agent)}
                  {p.model ? ` · ${p.model}` : ''}
                </span>{' '}
                <RunStatePill
                  state={p.state}
                  cancelled={p.cancelled}
                  autoRetry={p.autoRetry}
                  handedOffTo={p.handedOffTo}
                />{' '}
                <Link href={`/runs/${id}/review`} className="mono">
                  {id.slice(0, 8)}
                </Link>
              </>
            ) : (
              <span className="mono" title="This run is no longer listed">
                {id.slice(0, 8)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function DrawerAgentSection({ ctx }: { ctx: DrawerCtx }) {
  const {
    ticket,
    run,
    conflictFallback,
    title,
    viewTab,
    setViewTab,
    permissionMode,
    setPermissionMode,
    followUp,
    setFollowUp,
    busyAction,
    confirmStart,
    startRun,
    sendFollowUp,
    runAction,
    onDiscard,
    onAccept,
  } = ctx;
  const live = Boolean(run && !run.endedAt);
  const queued = run?.state === 'queued';
  const canFollowUp = (live && !queued) || run?.resumable === true;

  return (
    <section className="drawer-agent" aria-label="Agent">
      <div className="drawer-agent-head">
        <h2>Agent Execution</h2>
        {run && (
          <div className="agent-run">
            <RunStatePill
              state={run.state}
              cancelled={run.cancelled}
              autoRetry={run.autoRetry}
              handedOffTo={run.handedOffTo}
            />
            <span className="badge badge-soft mono">{formatAgentDisplayName(run.agent)}</span>
            {run.branch && <span className="badge badge-soft mono">{run.branch}</span>}
            {run.terminalId && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setViewTab(viewTab === 'terminal' ? 'details' : 'terminal')}
                >
                  {viewTab === 'terminal' ? 'Show spec' : 'Docked terminal'}
                </button>
                <Link
                  id="drawer-terminal"
                  href={`/terminals/${run.terminalId}`}
                  className="btn btn-sm btn-ghost"
                >
                  Open terminal →
                </Link>
              </>
            )}
          </div>
        )}
      </div>
      {run && <HandoffMenu run={run} />}
      {run && <AttemptChain run={run} />}
      {run && <RunFailureBanner run={run} />}
      {run && (
        <HoldRecovery
          key={run.id}
          run={run}
          onDiscard={onDiscard}
          onMerge={onAccept}
          conflictFallback={conflictFallback}
        />
      )}
      {/* The Events tab shows these itself, next to the final answer. */}
      {run && viewTab !== 'events' && <BuildOutputsList runId={run.id} refreshKey={run.stateChangedAt} />}
      {queued && (
        <div className="agent-note">
          <span>Queued: starts as soon as a slot and quota are free.</span>
          <button
            id="drawer-cancel"
            className="btn btn-sm btn-ghost"
            disabled={!!busyAction}
            onClick={() => void runAction('stop')}
          >
            Cancel
          </button>
        </div>
      )}
      {run?.state === 'rate_limited' && (
        <div className="agent-note agent-note-limit">
          <span>
            {run.autoRetry
              ? `A temporary provider error stopped the turn. ${formatAgentDisplayName(run.agent)} retries automatically at ${new Date(run.autoRetry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (attempt ${run.autoRetry.attempt} of ${run.autoRetry.max}).`
              : `Paused by the usage limit. ${formatAgentDisplayName(run.agent)} continues automatically when the window resets.`}
          </span>
          <button
            id="drawer-resume"
            className="btn btn-sm"
            disabled={!!busyAction}
            onClick={() => void runAction('resume')}
          >
            Resume now
          </button>
        </div>
      )}
      {canFollowUp && (
        <div className="run-form drawer-form">
          <div className="template-bar" aria-label="Stage prompt templates">
            <span className="template-label mono">Stage:</span>
            {STAGE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className="chip-btn"
                title={tpl.hint}
                onClick={() => setFollowUp(tpl.prompt)}
              >
                {tpl.label}
              </button>
            ))}
          </div>
          <textarea
            id="drawer-followup"
            className="input"
            rows={3}
            placeholder={
              !live || !run
                ? formatAgentResumePlaceholder(run?.agent)
                : run.state === 'waiting_input'
                  ? `${formatAgentDisplayName(run.agent)} is waiting for you…`
                  : `Follow-up for ${formatAgentDisplayName(run.agent)} (sent to the live session)`
            }
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && followUp.trim()) void sendFollowUp();
            }}
          />
          <div className="run-form-foot">
            <span className="muted small">
              {live
                ? 'Permission prompts are answered in the terminal.'
                : 'Resumes the same branch and conversation.'}
            </span>
            <button
              id="drawer-send"
              className="btn btn-sm btn-primary"
              disabled={!followUp.trim() || !!busyAction}
              onClick={() => void sendFollowUp()}
            >
              {busyAction === 'send' ? 'Sending…' : live ? 'Send' : 'Continue'}
            </button>
          </div>
        </div>
      )}
      {!live && (
        <div className="run-form drawer-form">
          <PermissionModePicker value={permissionMode} onChange={setPermissionMode} />
          <p className="muted small">
            {modeHint(permissionMode)}. Works on its own branch and worktree; queued if all slots are busy or
            the quota is exhausted.
          </p>
          <div className="run-form-foot">
            {ticket.blockedBy.length > 0 ? (
              <span className="muted small" role={confirmStart ? 'alert' : undefined}>
                {confirmStart ? 'Still waiting for ' : 'Waiting for '}
                {ticket.blockedBy.map((b) => b.key).join(', ')}. Starting now skips the wait.
              </span>
            ) : overlapWaitingFor(ticket) ? (
              <span className="muted small">
                {overlapWaitingLabel(overlapWaitingFor(ticket)!)}. Starting manually runs in parallel.
              </span>
            ) : (
              <span />
            )}
            <button
              id="drawer-start"
              className={`btn btn-sm ${run?.resumable && run.state !== 'failed' ? '' : 'btn-primary'}`}
              disabled={!!busyAction || !title.trim()}
              onClick={startRun}
            >
              {busyAction === 'start'
                ? 'Starting…'
                : confirmStart && ticket.blockedBy.length > 0
                  ? 'Start anyway'
                  : run
                    ? 'Start new run'
                    : 'Start Agent Run'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
