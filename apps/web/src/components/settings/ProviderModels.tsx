import type { AgentId } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api';
import {
  invalidateModelCatalog,
  type ProviderRead,
  type StoredCatalog,
  useModelCatalog,
} from '../../modelCatalog';
import { timeAgo } from '../../time';
import { ico } from '../SectionState';

const SOURCE_LABEL: Record<string, string> = { cli: 'CLI', picker: 'Model picker', manual: 'Added by you' };

/** What `POST /api/models/refresh` answers: the reads made, and why the others were skipped. */
type RefreshAnswer = {
  reads: Partial<Record<AgentId, ProviderRead>>;
  skipped?: Partial<Record<AgentId, string>>;
};

/** Why a provider's list was not read, as core names it. */
const SKIPPED: Record<string, string> = {
  no_reader: "Emberline does not read this CLI's model list; add its models by hand.",
  runner_away: 'Not read: the runner is not connected.',
  not_enabled: 'Not read: this provider is not enabled.',
  not_installed: 'Not read: its CLI is not installed.',
  installing: 'Not read yet: its CLI is being installed, and is read when that is done.',
  not_signed_in: 'Not read: its CLI is not signed in.',
  stopped: 'Not read: Emberline is shutting down.',
};

/** The line the card shows after Refresh models: read, failed, or why it was not read. */
function refreshOutcome(agent: AgentId, answer: RefreshAnswer): { text: string; bad: boolean } {
  const read = answer.reads[agent];
  if (read)
    return read.ok
      ? { text: 'Read just now.', bad: false }
      : { text: `The read failed: ${read.error ?? 'unknown error'}`, bad: true };
  const why = answer.skipped?.[agent];
  return { text: (why && SKIPPED[why]) || 'Not read.', bad: false };
}

/** One provider's models as stored: where each came from, when, and the last read of the CLI. */
export function ProviderModels({ providerId }: { providerId: AgentId }) {
  const client = useQueryClient();
  const query = useModelCatalog();
  const entry = query.data?.[providerId];
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; bad: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      await work();
      await invalidateModelCatalog(client);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // A read can take up to a minute (and waits for any read before it).
  const refresh = () =>
    run(async () => {
      setRefreshing(true);
      try {
        const answer = await api<RefreshAnswer>('/api/models/refresh', 'POST', { agent: providerId });
        setOutcome(refreshOutcome(providerId, answer));
      } finally {
        setRefreshing(false);
      }
    });
  const add = () =>
    run(async () => {
      const id = draft.trim();
      if (!id) return;
      await api<{ catalog: StoredCatalog }>(`/api/models/${providerId}/manual`, 'POST', { id });
      setDraft('');
    });
  const remove = (id: string) =>
    run(() => api(`/api/models/${providerId}/manual/${encodeURIComponent(id)}`, 'DELETE'));

  if (!entry) return null;
  const read = entry.read;
  const small = { fontSize: '0.68rem' } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-provider-models={providerId}>
      <div className="small" style={small}>
        <span className="muted">Last read: </span>
        {read ? (
          <>
            <span className={read.ok ? '' : 'badge badge-bad'}>{read.ok ? 'ok' : 'failed'}</span>{' '}
            <span className="muted">
              {timeAgo(read.at)}
              {read.cliVersion ? ` · CLI ${read.cliVersion}` : ''}
            </span>
            {read.error && <div style={{ color: 'var(--bad)' }}>{read.error}</div>}
          </>
        ) : (
          <span className="muted">never</span>
        )}
      </div>

      {entry.models.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          {entry.models.map((m) => (
            <li
              key={m.id}
              className="small"
              style={{ ...small, display: 'flex', gap: 6, alignItems: 'baseline' }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{m.label}</strong> <code className="mono">{m.id}</code>
                <span className="muted">
                  {' '}
                  · {SOURCE_LABEL[m.source] ?? m.source} · first seen {timeAgo(m.firstSeen)}
                </span>
                {m.missingSince && (
                  <span style={{ color: 'var(--warn)' }}> · missing since {timeAgo(m.missingSince)}</span>
                )}
              </span>
              {m.source === 'manual' && (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  disabled={busy}
                  aria-label={`Remove ${m.id}`}
                  title="Remove this model id"
                  onClick={() => void remove(m.id)}
                >
                  {ico(Trash2)}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          disabled={busy}
          onClick={() => void refresh()}
          title="Ask the CLI which models it offers now"
        >
          {refreshing ? ico(LoaderCircle, true) : ico(RefreshCw)}{' '}
          {refreshing ? 'Reading models…' : 'Refresh models'}
        </button>
        <input
          className="input mono"
          style={{ padding: '4px 8px', fontSize: '0.72rem', flex: 1, minWidth: 120 }}
          aria-label="Model id"
          placeholder="model id the CLI accepts"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          disabled={busy || !draft.trim()}
          onClick={() => void add()}
        >
          Add a model id
        </button>
      </div>
      {refreshing && (
        <div className="small muted" style={small} role="status">
          Asking the CLI for its models; this can take up to a minute.
        </div>
      )}
      {outcome && (
        <div
          className={outcome.bad ? 'small' : 'small muted'}
          style={{ ...small, ...(outcome.bad ? { color: 'var(--bad)' } : {}) }}
          role="status"
        >
          {outcome.text}
        </div>
      )}
      {error && <div style={{ ...small, color: 'var(--bad)' }}>{error}</div>}
    </div>
  );
}
