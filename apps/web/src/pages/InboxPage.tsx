import { type Project, type Run, type Ticket } from '@emberline/protocol';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { formatAgentDisplayName } from '../agentLabel';
import { answerOffered, answerTarget, refreshAfterAnswer } from '../answerDialog';
import { api, errorMessage } from '../api';
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
import { InboxNotices } from '../components/InboxNotices';
import { HelpHint } from '../components/ui/HelpHint';
import { MoreMenu, type MoreMenuItem } from '../components/ui/MoreMenu';
import { PageHeader } from '../components/ui/PageHeader';
import { recoveryApplies } from '../holdRecovery';
import { clearPresenceRun, setPresenceRun } from '../hooks/eventHub';
import { liveKeys, ticketsQuery } from '../hooks/liveData';
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
import { toastError } from '../toast';
import './inbox-ux.css';

/** Ticket key and title by id, from the projects' ticket lists (stable reference: re-run only on new data). */
const ticketNames = (lists: { data?: Ticket[] }[]): Map<string, TicketName> =>
  new Map(lists.flatMap((q) => (q.data ?? []).map((t) => [t.id, { key: t.key, title: t.title }] as const)));

/** A long non-question detail is clamped to this many lines until expanded. */
const CLAMP_CHARS = 280;

function InboxItem({
  run,
  project,
  heading,
  isPrimary,
  onOpen,
  onDismiss,
  onAnswer,
}: {
  run: Run;
  project: Project | undefined;
  heading: { key: string | null; title: string };
  isPrimary: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  /** Opens the Answer dialog with this start text. */
  onAnswer: (text: string) => void;
}) {
  const client = useQueryClient();
  const attention = run.attention!;
  const [expanded, setExpanded] = useState(false);
  const [resuming, setResuming] = useState(false);

  const detail = attentionDetail(attention);
  const keepFull = attention.reason === 'question' || attention.reason === 'permission';
  const long = !keepFull && ((detail?.length ?? 0) > CLAMP_CHARS || (detail?.split('\n').length ?? 0) > 6);

  const recovering = recoveryApplies(run);
  const recovery = useRunRecovery(run);

  const canAnswer = answerOffered(run, recovery.data);
  const canReview = Boolean(run.reviewReady || run.worktreePath);
  const canResume = run.state === 'rate_limited' || run.resumable;

  const primaryKind: 'answer' | 'review' | 'resume' | 'open' = canAnswer
    ? 'answer'
    : canReview && (run.reviewReady || run.state === 'done' || attention.reason === 'held')
      ? 'review'
      : canResume
        ? 'resume'
        : canReview
          ? 'review'
          : 'open';

  const handleResume = async () => {
    setResuming(true);
    try {
      await api(`/api/runs/${run.id}/resume`, 'POST', {});
      await client.invalidateQueries({ queryKey: liveKeys.runs });
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setResuming(false);
    }
  };

  const moreItems: MoreMenuItem[] = [];
  if (primaryKind !== 'review' && canReview) {
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
      href: `/terminals/${run.terminalId}`,
    });
  }
  if (primaryKind !== 'resume' && canResume) {
    moreItems.push({
      id: 'resume',
      label: resuming ? 'Resuming…' : 'Resume',
      disabled: resuming,
      onSelect: () => void handleResume(),
    });
  }
  if (primaryKind !== 'open') {
    moreItems.push({
      id: 'open-run',
      label: 'Open run',
      onSelect: onOpen,
    });
  }
  if (dismissable(attention.reason)) {
    moreItems.push({
      id: 'dismiss',
      label: 'Dismiss',
      onSelect: onDismiss,
    });
  }

  const primaryBtnClass = `btn btn-sm${isPrimary ? ' btn-primary' : ''}`;

  return (
    <li className="inbox-item" data-reason={attention.reason}>
      <div className="inbox-item-head">
        <span className={`inbox-chip inbox-chip-${attention.reason}`}>
          {ATTENTION_LABELS[attention.reason]}
        </span>
        {project && <span className="inbox-project mono">{project.name}</span>}
        <span className="inbox-agent muted mono">{formatAgentDisplayName(run.agent)}</span>
      </div>
      <h3 className="inbox-title">
        {heading.key && <span className="mono">{heading.key}</span>} {heading.title}
      </h3>
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
        {primaryKind === 'answer' ? (
          <button type="button" className={primaryBtnClass} onClick={() => onAnswer('')}>
            Answer
          </button>
        ) : primaryKind === 'review' ? (
          <Link href={`/runs/${run.id}/review`} className={primaryBtnClass}>
            Open review
          </Link>
        ) : primaryKind === 'resume' ? (
          <button
            type="button"
            className={primaryBtnClass}
            disabled={resuming}
            onClick={() => void handleResume()}
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        ) : (
          <button type="button" className={primaryBtnClass} onClick={onOpen}>
            Open run
          </button>
        )}
        {moreItems.length > 0 && (
          <MoreMenu items={moreItems} ariaLabel={`More actions for ${heading.key ?? heading.title}`} />
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
  const orderedRuns = useMemo(
    () => groupAttention(filteredPending, seen).flatMap((g) => g.runs),
    [filteredPending, seen],
  );

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
      <PageHeader
        title="Inbox"
        icon={<Inbox className="icon" aria-hidden />}
        meta={
          <>
            <span className="badge mono inbox-count-badge">{scopedPending.length}</span>
            <HelpHint topic="inbox">{inboxSubtitle(scoped, projectName)}</HelpHint>
          </>
        }
        actions={
          <>
            {activeProjectId && <AllProjectsToggle on={all} onChange={setAll} />}
            {notificationsSupported() && permission === 'default' && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void Notification.requestPermission().then(setPermission)}
              >
                Enable alerts
              </button>
            )}
          </>
        }
      />

      <MoreInOtherProjects count={elsewhere} onShow={() => setAll(true)} />

      <InboxNotices />

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
                    className={`chip-btn${pressed ? ' chip-on' : ''}`}
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
      ) : orderedRuns.length === 0 ? (
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
        <ul className="inbox-list">
          {orderedRuns.map((run, idx) => (
            <InboxItem
              key={run.attention!.occurrence}
              run={run}
              project={projectById.get(run.projectId)}
              heading={inboxHeading(run, ticketsById)}
              isPrimary={idx === 0 && (!activeProjectId || !all)}
              onOpen={() => onOpenRun(run.id)}
              onDismiss={() => onDismiss(run)}
              onAnswer={(text) => setAnswering({ run, heading: inboxHeading(run, ticketsById), text })}
            />
          ))}
        </ul>
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
