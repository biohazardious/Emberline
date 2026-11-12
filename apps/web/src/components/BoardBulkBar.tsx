import {
  type AgentPersona,
  BULK_TICKET_LIMIT,
  type BulkTicketBody,
  type BulkTicketFailure,
  type BulkTicketResult,
  type TicketStatus,
} from '@emberline/protocol';
import { Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import type { BoardSelection } from '../boardSelection';
import { BOARD_PRIORITIES } from './BoardCard';
import { PERSONA_LIST } from './PersonaBadge';

interface Props {
  projectId: string;
  columns: readonly { status: TicketStatus; label: string }[];
  selection: BoardSelection;
  onApplied: (result: BulkTicketResult) => void;
  onExit: () => void;
}

type BarState =
  | { kind: 'idle' }
  | { kind: 'confirm_delete' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'skipped'; failed: readonly BulkTicketFailure[] };

/**
 * The board's selection toolbar: move, reprioritise, reassign or delete every picked ticket in one
 * request. Escape leaves selection mode; tickets the server refused stay picked with their reason.
 */
export function BoardBulkBar({ projectId, columns, selection, onApplied, onExit }: Props) {
  const [state, setState] = useState<BarState>({ kind: 'idle' });
  const count = selection.length;
  const busy = state.kind === 'busy';
  const disabled = busy || count === 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[role="dialog"]')) return;
      if (state.kind === 'confirm_delete') setState({ kind: 'idle' });
      else onExit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onExit, state.kind]);

  const apply = async (body: BulkTicketBody) => {
    setState({ kind: 'busy' });
    try {
      const result = await api<BulkTicketResult>(`/api/projects/${projectId}/tickets/bulk`, 'POST', body);
      setState(result.failed.length > 0 ? { kind: 'skipped', failed: result.failed } : { kind: 'idle' });
      onApplied(result);
    } catch (e) {
      setState({ kind: 'error', message: errorMessage(e) });
    }
  };

  const ids = [...selection];

  return (
    <section className="bulk-bar" aria-label="Bulk ticket actions">
      <div className="bulk-bar-row">
        <span className="bulk-bar-count" aria-live="polite">
          <strong>{count}</strong> selected
          {count >= BULK_TICKET_LIMIT && <span className="bulk-bar-hint"> (limit {BULK_TICKET_LIMIT})</span>}
        </span>

        <label className="bulk-bar-field">
          <span>Move to</span>
          <select
            className="input"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const status = columns.find((c) => c.status === e.target.value)?.status;
              if (status) void apply({ action: 'move', ids, status });
            }}
          >
            <option value="" disabled>
              Column…
            </option>
            {columns.map((c) => (
              <option key={c.status} value={c.status}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="bulk-bar-field">
          <span>Priority</span>
          <select
            className="input"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const priority = BOARD_PRIORITIES.findIndex((p) => p === e.target.value);
              if (priority !== -1) void apply({ action: 'priority', ids, priority });
            }}
          >
            <option value="" disabled>
              Set…
            </option>
            {BOARD_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label className="bulk-bar-field">
          <span>Persona</span>
          <select
            className="input"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const persona: AgentPersona | undefined = PERSONA_LIST.find((p) => p.id === e.target.value)?.id;
              if (persona) void apply({ action: 'persona', ids, persona });
            }}
          >
            <option value="" disabled>
              Assign…
            </option>
            {PERSONA_LIST.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.shortLabel}] {p.label}
              </option>
            ))}
          </select>
        </label>

        {state.kind === 'confirm_delete' ? (
          <span className="bulk-bar-confirm" role="group" aria-label="Confirm delete">
            <span>
              Delete {count} ticket{count === 1 ? '' : 's'}?
            </span>
            <button
              type="button"
              className="btn btn-sm danger"
              autoFocus
              onClick={() => void apply({ action: 'delete', ids })}
            >
              Delete
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setState({ kind: 'idle' })}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => setState({ kind: 'confirm_delete' })}
          >
            <Trash2 className="icon" aria-hidden /> Delete
          </button>
        )}

        {busy && (
          <span className="bulk-bar-hint" role="status">
            Applying…
          </span>
        )}

        <button
          type="button"
          className="btn btn-sm btn-ghost bulk-bar-exit"
          onClick={onExit}
          title="Leave selection mode (Esc)"
        >
          <X className="icon" aria-hidden /> Done <kbd className="kbd">Esc</kbd>
        </button>
      </div>

      {state.kind === 'error' && (
        <p className="bulk-bar-error" role="alert">
          Nothing changed: {state.message}
        </p>
      )}
      {state.kind === 'skipped' && (
        <div className="bulk-bar-skipped" role="alert">
          <p>
            {state.failed.length} ticket{state.failed.length === 1 ? ' was' : 's were'} left as they were and
            stay selected:
          </p>
          <ul>
            {state.failed.map((f) => (
              <li key={f.id}>
                <span className="mono">{f.key ?? f.id}</span> {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
