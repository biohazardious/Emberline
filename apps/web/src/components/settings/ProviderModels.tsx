import { type AgentId, PROVIDER_REGISTRY } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api';
import {
  invalidateModelCatalog,
  type ProviderRead,
  type StoredCatalog,
  type StoredModel,
  useModelCatalog,
} from '../../modelCatalog';
import { timeAgo } from '../../time';
import { ico } from '../SectionState';
import './providers/providers.css';

const SOURCE_LABEL: Record<string, string> = {
  builtin: 'Built-in',
  cli: 'CLI',
  picker: 'Model picker',
  manual: 'Added by you',
};

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

type MergedModelRow = {
  id: string;
  label: string;
  shortLabel: string;
  rank: number;
  tier: 'low' | 'medium' | 'high';
  source: string;
  firstSeen: string | null;
  missingSince: string | null;
};

function mergeProviderModels(providerId: AgentId, stored: StoredModel[]): MergedModelRow[] {
  const builtins = PROVIDER_REGISTRY[providerId].models;
  const byId = new Map(stored.map((m) => [m.id, m]));
  const rows: MergedModelRow[] = builtins.map((b) => {
    const c = byId.get(b.id);
    if (c) {
      return {
        id: c.id,
        label: c.label,
        shortLabel: b.shortLabel || c.shortLabel,
        rank: b.rank,
        tier: b.tier,
        source: c.source,
        firstSeen: c.firstSeen ?? null,
        missingSince: c.missingSince ?? null,
      };
    }
    return {
      id: b.id,
      label: b.label,
      shortLabel: b.shortLabel,
      rank: b.rank,
      tier: b.tier,
      source: 'builtin',
      firstSeen: null,
      missingSince: null,
    };
  });
  const builtinIds = new Set(builtins.map((b) => b.id));
  for (const m of stored) {
    if (builtinIds.has(m.id)) continue;
    rows.push({
      id: m.id,
      label: m.label,
      shortLabel: m.shortLabel,
      rank: m.rank,
      tier: m.tier,
      source: m.source,
      firstSeen: m.firstSeen ?? null,
      missingSince: m.missingSince ?? null,
    });
  }
  return rows;
}

/** One provider's models (built-in rank chips merged with discovered/manual models) and last CLI read. */
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

  const read = entry?.read ?? null;
  const rows = mergeProviderModels(providerId, entry?.models ?? []);

  return (
    <div className="provider-models" data-provider-models={providerId}>
      <div className="small provider-models-read">
        <span className="muted">Last read: </span>
        {read ? (
          <>
            <span className={read.ok ? '' : 'badge badge-bad'}>{read.ok ? 'ok' : 'failed'}</span>{' '}
            <span className="muted">
              {timeAgo(read.at)}
              {read.cliVersion ? ` · CLI ${read.cliVersion}` : ''}
            </span>
            {read.error && <div className="provider-models-error">{read.error}</div>}
          </>
        ) : (
          <span className="muted">never</span>
        )}
      </div>

      {rows.length > 0 && (
        <ul className="provider-models-list">
          {rows.map((m) => (
            <li key={m.id} className="small provider-models-item">
              <span className="provider-models-item-main">
                <span className={`mono provider-model-rank provider-model-rank-${m.tier}`}>
                  ★{m.rank} {m.shortLabel}
                </span>
                <strong>{m.label}</strong>
                <code className="mono">{m.id}</code>
                <span className="muted">
                  · {SOURCE_LABEL[m.source] ?? m.source}
                  {m.firstSeen ? ` · first seen ${timeAgo(m.firstSeen)}` : ''}
                </span>
                {m.missingSince && (
                  <span className="provider-models-missing"> · missing since {timeAgo(m.missingSince)}</span>
                )}
              </span>
              {m.source === 'manual' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  aria-label={`Remove ${m.id}`}
                  onClick={() => void remove(m.id)}
                >
                  {ico(Trash2)}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="provider-models-controls">
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void refresh()}>
          {refreshing ? ico(LoaderCircle, true) : ico(RefreshCw)}{' '}
          {refreshing ? 'Reading models…' : 'Refresh models'}
        </button>
        <input
          className="input mono provider-models-input"
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
          className="btn btn-sm btn-ghost"
          disabled={busy || !draft.trim()}
          onClick={() => void add()}
        >
          Add model
        </button>
      </div>
      {refreshing && (
        <div className="small muted provider-models-status" role="status">
          Asking the CLI for its models; this can take up to a minute.
        </div>
      )}
      {outcome && (
        <div
          className={
            outcome.bad
              ? 'small provider-models-status provider-models-error'
              : 'small muted provider-models-status'
          }
          role="status"
        >
          {outcome.text}
        </div>
      )}
      {error && <div className="provider-models-error">{error}</div>}
    </div>
  );
}
