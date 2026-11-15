import type { AgentId } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api';
import { invalidateModelCatalog, type StoredCatalog, useModelCatalog } from '../../modelCatalog';
import { timeAgo } from '../../time';
import { ico } from '../SectionState';

const SOURCE_LABEL: Record<string, string> = { cli: 'CLI', picker: 'Model picker', manual: 'Added by you' };

/** One provider's models as stored: where each came from, when, and the last read of the CLI. */
export function ProviderModels({ providerId }: { providerId: AgentId }) {
  const client = useQueryClient();
  const query = useModelCatalog();
  const entry = query.data?.[providerId];
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await invalidateModelCatalog(client);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => run(() => api('/api/models/refresh', 'POST', { agent: providerId }));
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
          {busy ? ico(LoaderCircle, true) : ico(RefreshCw)} Refresh models
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
      {error && <div style={{ ...small, color: 'var(--bad)' }}>{error}</div>}
    </div>
  );
}
