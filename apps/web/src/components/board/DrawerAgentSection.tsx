import type { Run } from '@emberline/protocol';
import { Link } from 'wouter';
import { useRuns } from '../../hooks/liveData';
import { overlapWaitingFor, overlapWaitingLabel } from '../../ticketDeps';
import { HoldRecovery } from '../HoldRecovery';
import { modeHint, PermissionModePicker } from '../PermissionModePicker';
import { PersonaPicker, TaskTemplateBar } from '../PersonaBadge';
import { HandoffMenu } from '../QuotaLanes';
import {
  formatAgentDisplayName,
  formatAgentResumePlaceholder,
  RunFailureBanner,
  STAGE_TEMPLATES,
} from '../RunInspector';
import { BuildOutputsList } from '../RunOutcome';
import { RunStatePill } from '../RunStatePill';
import { Disclosure } from '../ui/Disclosure';
import type { DrawerCtx } from './boardMeta';

/** The runs that came before `run` in its handoff chain (oldest first); the same attempt continued on other routes. */
export function AttemptChain({ run }: { run: Run }) {
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
              <span className="mono">{id.slice(0, 8)}</span>
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
    primaryAction,
    title,
    setTitle,
    setBody,
    persona,
    setPersona,
    viewTab,
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
        <h2>Agent</h2>
        {run && (
          <div className="agent-run">
            <span className="badge badge-soft mono">{formatAgentDisplayName(run.agent)}</span>
            {run.branch && <span className="badge badge-soft mono">{run.branch}</span>}
            {run.worktreePath && (
              <Link
                href={`/runs/${run.id}/review`}
                className={`btn btn-sm${primaryAction === 'open_review' ? ' btn-primary' : ''}`}
              >
                Open review
              </Link>
            )}
            {run.terminalId && (
              <Link
                id="drawer-terminal"
                href={`/terminals/${run.terminalId}`}
                className="btn btn-sm btn-ghost"
              >
                Open terminal
              </Link>
            )}
          </div>
        )}
      </div>

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
      {run && viewTab !== 'events' && <BuildOutputsList runId={run.id} refreshKey={run.stateChangedAt} />}

      {queued && (
        <div className="agent-note">
          <span>Queued for next free slot.</span>
          <button
            id="drawer-cancel"
            type="button"
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
              ? `Retrying at ${new Date(run.autoRetry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${run.autoRetry.attempt}/${run.autoRetry.max}).`
              : `Paused by usage limit; ${formatAgentDisplayName(run.agent)} resumes on reset.`}
          </span>
          <button
            id="drawer-resume"
            type="button"
            className="btn btn-sm"
            disabled={!!busyAction}
            onClick={() => void runAction('resume')}
          >
            Resume
          </button>
        </div>
      )}

      {canFollowUp && (
        <div className="run-form drawer-form">
          <textarea
            id="drawer-followup"
            className="input"
            rows={2}
            placeholder={
              !live || !run
                ? formatAgentResumePlaceholder(run?.agent)
                : run.state === 'waiting_input'
                  ? `${formatAgentDisplayName(run.agent)} is waiting for you…`
                  : `Follow-up for ${formatAgentDisplayName(run.agent)}…`
            }
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && followUp.trim()) void sendFollowUp();
            }}
          />
          <div className="run-form-foot">
            <span />
            <button
              id="drawer-send"
              type="button"
              className={`btn btn-sm${primaryAction === 'send' ? ' btn-primary' : ''}`}
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
          <div className="run-form-foot">
            {ticket.blockedBy.length > 0 ? (
              <span className="muted small" role={confirmStart ? 'alert' : undefined}>
                {confirmStart ? 'Still waiting for ' : 'Waiting for '}
                {ticket.blockedBy.map((b) => b.key).join(', ')}.
              </span>
            ) : overlapWaitingFor(ticket) ? (
              <span className="muted small">{overlapWaitingLabel(overlapWaitingFor(ticket)!)}.</span>
            ) : (
              <span />
            )}
            <button
              id="drawer-start"
              type="button"
              className={`btn btn-sm${primaryAction === 'start' ? ' btn-primary' : ''}`}
              disabled={!!busyAction || !title.trim()}
              onClick={startRun}
            >
              {busyAction === 'start'
                ? 'Starting…'
                : confirmStart && ticket.blockedBy.length > 0
                  ? 'Start anyway'
                  : run
                    ? 'Start new run'
                    : 'Start'}
            </button>
          </div>
        </div>
      )}

      <Disclosure label="Advanced">
        <div className="drawer-advanced">
          <label className="drawer-label">Persona</label>
          <PersonaPicker value={persona} onChange={setPersona} />
          <TaskTemplateBar
            onSelect={(tpl) => {
              setPersona(tpl.persona);
              setPermissionMode(tpl.permissionMode);
              if (!title.trim()) setTitle(tpl.titlePlaceholder);
              setBody(tpl.promptTemplate);
            }}
          />
          {!live && (
            <>
              <label className="drawer-label">Permission mode</label>
              <PermissionModePicker value={permissionMode} onChange={setPermissionMode} />
              <p className="muted small">{modeHint(permissionMode)}</p>
            </>
          )}
          {canFollowUp && (
            <div className="template-bar" aria-label="Stage prompt templates">
              <span className="template-label mono">Stage:</span>
              {STAGE_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className="chip-btn"
                  onClick={() => setFollowUp(tpl.prompt)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          )}
          {run && <HandoffMenu run={run} />}
        </div>
      </Disclosure>
    </section>
  );
}
