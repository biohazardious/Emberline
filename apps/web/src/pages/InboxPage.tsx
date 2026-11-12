import { type Project, type Run, type Ticket } from '@emberline/protocol';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { answerOffered, answerTarget, refreshAfterAnswer } from '../answerDialog';
import {
  ATTENTION_LABELS,
  ATTENTION_ORDER,
  attentionDetail,
  dismissable,
  groupAttention,
  inboxHeading,
  needsElsewhere,
  pendingAttention,
  type SeenMap,
  type TicketName,
} from '../attention';
import { AllProjectsToggle, MoreInOtherProjects } from '../components/AllProjectsToggle';
import { AnswerDialog } from '../components/AnswerDialog';
import { SearchInput } from '../components/BoardFilterBar';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { HoldRecovery, useRunRecovery } from '../components/HoldRecovery';
import { PersonaBadge } from '../components/PersonaBadge';
import { recoveryApplies } from '../holdRecovery';
import { clearPresenceRun, setPresenceRun } from '../hooks/eventHub';
import { ticketsQuery } from '../hooks/liveData';
import { useAllProjects } from '../hooks/useAllProjects';
import { useApi } from '../hooks/useApi';
import { notificationsSupported } from '../hooks/useAttention';
import { inboxSubtitle, inScope } from '../projectScope';
import { toggled } from '../roadmapFilter';
import {
  countInboxReasons,
  EMPTY_INBOX_FILTER,
  filterInboxRuns,
  type InboxFilter,
  isInboxFilterActive,
} from '../runFilter';
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
  onAnswer,
}: {
  run: Run;
  project: Project | undefined;
  heading: { key: string | null; title: string };
  onOpen: () => void;
  onDismiss: () => void;
  /** Opens the Answer dialog with this start text. */
  onAnswer: (text: string) => void;
}) {
  const attention = run.attention!;
  const [expanded, setExpanded] = useState(false);
  useNow(30_000);

  const detail = attentionDetail(attention);
  const long = (detail?.length ?? 0) > CLAMP_CHARS || (detail?.split('\n').length ?? 0) > 6;

  const recovering = recoveryApplies(run);
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
      {recovering && <HoldRecovery key={run.id} run={run} onAnswer={onAnswer} hideLabel />}
      <div className="inbox-actions">
        {answerOffered(run, recovery.data) && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onAnswer('')}>
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
    </li>
  );
}

export function InboxPage({
  runs,
  runsLoading = false,
  runsError,
  onRetryRuns,
  seen,
  activeProjectId,
  projectName,
  onOpenRun,
  onDismiss,
}: {
  runs: Run[] | undefined;
  runsLoading?: boolean;
  runsError?: unknown;
  onRetryRuns?: () => Promise<void>;
  seen: SeenMap;
  activeProjectId: string | null;
  projectName?: string;
  onOpenRun: (runId: string) => void;
  onDismiss: (run: Run) => void;
}) {
  const client = useQueryClient();
  const projects = useApi<Project[]>('/api/projects', 15_000);
  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const [all, setAll] = useAllProjects('inbox');
  const [filter, setFilter] = useState<InboxFilter>(EMPTY_INBOX_FILTER);

  const scopedPending = useMemo(
    () =>
      pendingAttention(
        inScope(runs ?? [], (r) => r.projectId, { activeProjectId, all }),
        seen,
      ),
    [runs, seen, activeProjectId, all],
  );

  const ticketProjects = useMemo(
    () => [...new Set(scopedPending.filter((r) => r.ticketId).map((r) => r.projectId))].sort(),
    [scopedPending],
  );
  const ticketsById = useQueries({
    queries: ticketProjects.map(ticketsQuery),
    combine: ticketNames,
  });

  const reasonCounts = useMemo(() => countInboxReasons(scopedPending), [scopedPending]);
  const filteredPending = useMemo(
    () =>
      filterInboxRuns(scopedPending, filter, (run) => {
        const heading = inboxHeading(run, ticketsById);
        const pName = projectById.get(run.projectId)?.name ?? '';
        return `${heading.key ?? ''} ${heading.title} ${pName}`;
      }),
    [scopedPending, filter, ticketsById, projectById],
  );
  const groups = useMemo(() => groupAttention(filteredPending, seen), [filteredPending, seen]);

  const elsewhere = all ? 0 : needsElsewhere(runs ?? [], seen, activeProjectId);
  const scoped = Boolean(activeProjectId) && !all;
  const filterActive = isInboxFilterActive(filter);
  const showFilterBar = scopedPending.length > 1 || filterActive;

  const [permission, setPermission] = useState<NotificationPermission>(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  );
  const [answering, setAnswering] = useState<{
    run: Run;
    heading: { key: string | null; title: string };
    text: string;
  } | null>(null);
  const answerRun = answering ? answerTarget(runs, answering.run) : null;
  const answerRunId = answerRun?.id;
  useEffect(() => {
    if (!answerRunId) return;
    setPresenceRun(answerRunId, 'inbox');
    return () => clearPresenceRun(answerRunId, 'inbox');
  }, [answerRunId]);

  const visibleReasons = ATTENTION_ORDER.filter(
    (reason) => reasonCounts[reason] > 0 || filter.reasons.includes(reason),
  );

  return (
    <div className="inbox-page">
      <header className="workspace-bar">
        <div className="workspace-bar-title">
          <h1>Inbox</h1>
          <span className="muted small">{inboxSubtitle(scoped, projectName)}</span>
        </div>
        <div className="workspace-bar-controls">
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
        </div>
      </header>

      <MoreInOtherProjects count={elsewhere} onShow={() => setAll(true)} />

      {Boolean(runsError && !runs) && (
        <ViewErrorBanner label="Could not load inbox items" error={runsError} onRetry={onRetryRuns} />
      )}

      {showFilterBar && (
        <div className="board-filter inbox-filter" role="search" aria-label="Filter inbox items">
          <SearchInput
            id="inbox-search"
            className="board-search"
            ariaLabel="Filter inbox items"
            placeholder="Filter by ticket, title, detail, provider…"
            value={filter.query}
            onChange={(query) => setFilter({ ...filter, query })}
          />
          {visibleReasons.length > 0 && (
            <div className="board-filter-group" role="group" aria-label="Filter by attention reason">
              {visibleReasons.map((reason) => {
                const pressed = filter.reasons.includes(reason);
                return (
                  <button
                    key={reason}
                    type="button"
                    className={`chip-btn${pressed ? ' active' : ''}`}
                    aria-pressed={pressed}
                    onClick={() => setFilter({ ...filter, reasons: toggled(filter.reasons, reason) })}
                  >
                    {ATTENTION_LABELS[reason]}
                    <span className="board-filter-count mono">{reasonCounts[reason]}</span>
                  </button>
                );
              })}
            </div>
          )}
          {filterActive && (
            <div className="board-filter-status">
              <span className="muted small mono">
                {filteredPending.length} of {scopedPending.length}
              </span>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => setFilter(EMPTY_INBOX_FILTER)}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {runsLoading && !runs && !runsError ? (
        <ViewLoadingState label="Checking runs needing attention…" />
      ) : groups.length === 0 ? (
        <div className="empty">
          {filterActive && scopedPending.length > 0 ? (
            <>
              <p>No inbox items match your filter.</p>
              <button type="button" className="btn btn-sm" onClick={() => setFilter(EMPTY_INBOX_FILTER)}>
                Clear filter
              </button>
            </>
          ) : (
            <p>{scoped ? 'Nothing in this project needs you right now.' : 'Nothing needs you right now.'}</p>
          )}
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
                  onAnswer={(text) => setAnswering({ run, heading: inboxHeading(run, ticketsById), text })}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      {answering && answerRun && (
        <AnswerDialog
          key={answerRun.id}
          run={answerRun}
          heading={answering.heading}
          initialText={answering.text}
          onClose={() => setAnswering(null)}
          onSent={() => refreshAfterAnswer(client, answerRun.id)}
        />
      )}
    </div>
  );
}
