import type { Notice } from '@emberline/protocol';
import { Link } from 'wouter';
import { api } from '../api';
import { useApi } from '../hooks/useApi';
import { toastError } from '../toast';
import { timeAgo } from '../time';

/** The notices still open, newest first. */
export const openNotices = (list: Notice[] | undefined): Notice[] =>
  (list ?? []).filter((n) => !n.dismissedAt);

/**
 * Inbox notices above the runs: news that needs no action (new models, an unread model list).
 * They are kept out of the topbar's "need you" count. Pushed changes arrive through LiveEvents.
 */
export function InboxNotices() {
  const notices = useApi<Notice[]>('/api/notices', false);
  const open = openNotices(notices.data);
  if (open.length === 0) return null;

  const dismiss = (notice: Notice) => {
    api(`/api/notices/${notice.id}/dismiss`, 'POST')
      .then(() => notices.refresh())
      .catch((err: unknown) => toastError(err instanceof Error ? err.message : 'Could not dismiss'));
  };

  return (
    <section className="inbox-group" aria-label="Notices">
      <h2 className="inbox-group-head">
        Notices <span className="muted mono">{open.length}</span>
      </h2>
      <ul className="inbox-list">
        {open.map((notice) => (
          <li key={notice.id} className="inbox-item" data-kind={notice.kind}>
            <div className="inbox-item-head">
              <h3 className="inbox-title">{notice.title}</h3>
              <span className="inbox-age muted mono" title={notice.createdAt}>
                {timeAgo(notice.createdAt)}
              </span>
            </div>
            <p className="inbox-detail">{notice.text}</p>
            <div className="inbox-actions">
              {notice.link && (
                <Link className="btn btn-sm" href={notice.link}>
                  Open Settings
                </Link>
              )}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => dismiss(notice)}>
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
