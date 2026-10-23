import { type Project, type Run, type Ticket } from '@emberline/protocol';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  ATTENTION_LABELS,
  attentionDetail,
  dismissable,
  groupAttention,
  inboxHeading,
  needsElsewhere,
  type SeenMap,
  type TicketName,
} from '../attention';
import { AllProjectsToggle, MoreInOtherProjects } from '../components/AllProjectsToggle';
import { answerOffered } from '../answerDialog';
import { AnswerDialog } from '../components/AnswerDialog';
import { HoldRecovery, useRunRecovery } from '../components/HoldRecovery';
import { recoveryApplies } from '../holdRecovery';
import { PersonaBadge } from '../components/PersonaBadge';
import { notificationsSupported } from '../hooks/useAttention';
import { clearPresenceRun, setPresenceRun } from '../hooks/eventHub';
import { useAllProjects } from '../hooks/useAllProjects';
import { useApi } from '../hooks/useApi';
import { inboxSubtitle, inScope } from '../projectScope';
import { ticketsQuery } from '../hooks/liveData';
import { timeAgo, useNow } from '../time';

/** Ticket key and title by id, from the projects' ticket lists (stable reference: re-run only on new data). */
const ticketNames = (lists: { data?: Ticket[] }[]): Map<string, TicketName> =>
  new Map(lists.flatMap((q) => (q.data ?? []).map((t) => [t.id, { key: t.key, title: t.title }] as const)));

/** A long detail is clamped to this many lines until expanded (set in CSS as .inbox-detail-clamped). */
const CLAMP_CHARS = 280;

function InboxItem({
  run,
  project,
  heading,
  onOpen,
  onDismiss,
}: {
  run: Run;
  project: Project | undefined;
  heading: { key: string | null; title: string };
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const attention = run.attention!;
  const [expanded, setExpanded] = useState(false);
  // The Answer dialog (undefined: closed) and its start text.
  const [answer, setAnswer] = useState<string>();
  useNow(30_000);
  // Presence tells core the person is looking, so no push notification goes out while the dialog is open.
  const answering = answer !== undefined;
  useEffect(() => {
    if (!answering) return;
    setPresenceRun(run.id, 'inbox');
    return () => clearPresenceRun(run.id, 'inbox');
  }, [answering, run.id]);

  // Held detail is already the HOLD_LABELS label (the map covers an unexpected raw key); a failure's is its type.
  const detail = attentionDetail(attention);
  const long = (detail?.length ?? 0) > CLAMP_CHARS || (detail?.split('\n').length ?? 0) > 6;

  const recovering = recoveryApplies(run);
  // A held run that can't take a prompt: the hold block says why and offers Copy instead of Answer.
  const recovery = useRunRecovery(run);

  return (
    <li className="inbox-item" data-reason={attention.reason}>
      <div className="inbox-item-head">
        <span className={`inbox-chip inbox-chip-${attention.reason}`}>
          {ATTENTION_LABELS[attention.reason]}
        </span>
        {project && <span className="inbox-project mono">{project.name}</span>}
        <span className="inbox-age muted mono" title={attention.since}>
          {timeAgo(attention.since)}
        </span>
      </div>
      <h3 className="inbox-title">
        {heading.key && <span className="mono">{heading.key}</span>} {heading.title}
      </h3>
      <div className="inbox-meta muted small">
        <span className="mono">{run.agent}</span>
        <PersonaBadge persona={run.persona} />
      </div>
      {detail && (
        <div>
          <p className={`inbox-detail${long && !expanded ? ' inbox-detail-clamped' : ''}`}>{detail}</p>
          {long && (
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {recovering && <HoldRecovery key={run.id} run={run} onAnswer={setAnswer} />}
      <div className="inbox-actions">
        {answerOffered(run, recovery.data) && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAnswer('')}>
            Answer
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          Open run
        </button>
        {dismissable(attention.reason) && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {answering && (
        <AnswerDialog run={run} heading={heading} initialText={answer} onClose={() => setAnswer(undefined)} />
      )}
    </li>
  );
}

export function InboxPage({
  runs,
  seen,
  activeProjectId,
  projectName,
  onOpenRun,
  onDismiss,
}: {
  runs: Run[] | undefined;
  seen: SeenMap;
  activeProjectId: string | null;
  projectName?: string;
  onOpenRun: (runId: string) => void;
  onDismiss: (run: Run) => void;
}) {
  const projects = useApi<Project[]>('/api/projects', 15_000);
  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const [all, setAll] = useAllProjects('inbox');
  const groups = useMemo(
    () =>
      groupAttention(
        inScope(runs ?? [], (r) => r.projectId, { activeProjectId, all }),
        seen,
      ),
    [runs, seen, activeProjectId, all],
  );
  // The badges count every project; say what this view leaves out.
  const elsewhere = all ? 0 : needsElsewhere(runs ?? [], seen, activeProjectId);
  const scoped = Boolean(activeProjectId) && !all;
  // Ticket key and current title from the live tickets cache (the Board's), one read per project
  // that has a ticket run in the Inbox; ticket events keep it current.
  const ticketProjects = useMemo(
    () =>
      [...new Set(groups.flatMap((g) => g.runs.filter((r) => r.ticketId).map((r) => r.projectId)))].sort(),
    [groups],
  );
  const ticketsById = useQueries({
    queries: ticketProjects.map(ticketsQuery),
    combine: ticketNames,
  });
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  );

  return (
    <div className="inbox-page">
      <header className="workspace-bar">
        <div className="workspace-bar-title">
          <h1>Inbox</h1>
          <span className="muted small">{inboxSubtitle(scoped, projectName)}</span>
        </div>
        {activeProjectId && <AllProjectsToggle on={all} onChange={setAll} />}
        {notificationsSupported() && permission === 'default' && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void Notification.requestPermission().then(setPermission)}
          >
            Enable desktop alerts
          </button>
        )}
      </header>
      <MoreInOtherProjects count={elsewhere} onShow={() => setAll(true)} />
      {groups.length === 0 ? (
        <div className="empty">
          <p>{scoped ? 'Nothing in this project needs you right now.' : 'Nothing needs you right now.'}</p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.reason} className="inbox-group" aria-label={ATTENTION_LABELS[group.reason]}>
            <h2 className="inbox-group-head">
              {ATTENTION_LABELS[group.reason]} <span className="muted mono">{group.runs.length}</span>
            </h2>
            <ul className="inbox-list">
              {group.runs.map((run) => (
                <InboxItem
                  key={run.attention!.occurrence}
                  run={run}
                  project={projectById.get(run.projectId)}
                  heading={inboxHeading(run, ticketsById)}
                  onOpen={() => onOpenRun(run.id)}
                  onDismiss={() => onDismiss(run)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
