import { HOLD_LABELS, type Project, type Run, type RunAttentionReason } from '@emberline/protocol';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { ATTENTION_LABELS, dismissable, groupAttention, type SeenMap } from '../attention';
import { PersonaBadge } from '../components/PersonaBadge';
import { notificationsSupported } from '../hooks/useAttention';
import { setPresenceRun } from '../hooks/eventHub';
import { useApi } from '../hooks/useApi';
import { timeAgo, useNow } from '../time';
import { toastInfo } from '../toast';

const REPLYABLE: ReadonlySet<RunAttentionReason> = new Set(['question', 'permission', 'held', 'blocked']);
/** A long detail is clamped to this many lines until expanded (set in CSS as .inbox-detail-clamped). */
const CLAMP_CHARS = 280;

const REPLY_HINT: Partial<Record<RunAttentionReason, string>> = {
  question: 'Answer the agent…',
  permission: 'Reply to the permission prompt (or open the run for the terminal)…',
  held: 'Tell the agent what to do about this hold…',
  blocked: 'Tell the agent how to unblock…',
};

function InboxItem({
  run,
  project,
  onOpen,
  onDismiss,
}: {
  run: Run;
  project: Project | undefined;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const attention = run.attention!;
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useNow(30_000);
  useEffect(() => () => setPresenceRun(null, 'inbox'), []);

  // Held detail is already the HOLD_LABELS label; fall back to the map for an unexpected raw key.
  const detail = attention.detail === null ? null : (HOLD_LABELS[attention.detail] ?? attention.detail);
  const long = (detail?.length ?? 0) > CLAMP_CHARS || (detail?.split('\n').length ?? 0) > 6;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/runs/${run.id}/prompt`, 'POST', { text: value });
      setText('');
      toastInfo('Reply sent.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="inbox-item" data-reason={attention.reason}>
      <div className="inbox-item-head">
        <span className={`inbox-chip inbox-chip-${attention.reason}`}>{ATTENTION_LABELS[attention.reason]}</span>
        <span className="inbox-project mono">{project?.name ?? 'Project'}</span>
        <span className="inbox-age muted mono" title={attention.since}>
          {timeAgo(attention.since)}
        </span>
      </div>
      <h3 className="inbox-title">{run.title ?? 'Ad-hoc run'}</h3>
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
      {REPLYABLE.has(attention.reason) && (
        <form className="inbox-reply" onSubmit={(e) => void send(e)}>
          <textarea
            className="input inbox-reply-input"
            rows={1}
            value={text}
            placeholder={REPLY_HINT[attention.reason]}
            aria-label={`Reply to ${run.title ?? 'the agent'}`}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setPresenceRun(run.id, 'inbox')}
            onBlur={() => setPresenceRun(null, 'inbox')}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      <div className="inbox-actions">
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
  seen,
  onOpenRun,
  onDismiss,
}: {
  runs: Run[] | undefined;
  seen: SeenMap;
  onOpenRun: (runId: string) => void;
  onDismiss: (run: Run) => void;
}) {
  const projects = useApi<Project[]>('/api/projects', 15_000);
  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const groups = useMemo(() => groupAttention(runs ?? [], seen), [runs, seen]);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  );

  return (
    <div className="inbox-page">
      <header className="workspace-bar">
        <div className="workspace-bar-title">
          <h1>Inbox</h1>
          <span className="muted small">Runs that need you, across all projects · Alt+N opens the oldest</span>
        </div>
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
      {groups.length === 0 ? (
        <div className="empty">
          <p>Nothing needs you right now.</p>
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
