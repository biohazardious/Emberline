import type { Ticket, TicketExportFormat, TicketStatus } from '@emberline/protocol';
import { Download, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../api';
import { downloadBoardExport } from '../boardExport';
import { toastInfo } from '../toast';

export interface ExportColumn {
  status: TicketStatus;
  label: string;
}

interface Props {
  projectId: string;
  columns: readonly ExportColumn[];
  tickets: readonly Ticket[] | undefined;
  openFormat?: TicketExportFormat | null;
  onClose?: () => void;
  hideTrigger?: boolean;
}

type ExportState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string };

/** Board export dialog: pick a format and columns, then download the board as CSV or JSON. */
export function BoardExportMenu({
  projectId,
  columns,
  tickets,
  openFormat,
  onClose,
  hideTrigger = false,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [format, setFormat] = useState<TicketExportFormat>(openFormat ?? 'csv');
  const [picked, setPicked] = useState<ReadonlySet<TicketStatus>>(
    () => new Set(columns.map((c) => c.status)),
  );
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const isControlled = openFormat !== undefined;
  const open = isControlled ? openFormat !== null : internalOpen;

  useEffect(() => {
    if (openFormat) {
      setFormat(openFormat);
      setState({ kind: 'idle' });
    }
  }, [openFormat]);

  const closePanel = () => {
    if (isControlled) onClose?.();
    else setInternalOpen(false);
  };

  const counts = useMemo(() => {
    const byStatus = new Map<TicketStatus, number>(columns.map((c) => [c.status, 0]));
    for (const t of tickets ?? []) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    return byStatus;
  }, [columns, tickets]);
  const selectedCount = columns.reduce(
    (n, c) => n + (picked.has(c.status) ? (counts.get(c.status) ?? 0) : 0),
    0,
  );

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent | MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        if (isControlled) onClose?.();
        else setInternalOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isControlled) onClose?.();
      else setInternalOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    rootRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, isControlled, onClose]);

  const toggle = (status: TicketStatus) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  const run = async () => {
    setState({ kind: 'busy' });
    try {
      const fileName = await downloadBoardExport({ projectId, format, statuses: [...picked] });
      setState({ kind: 'idle' });
      closePanel();
      toastInfo(`Exported ${selectedCount} ticket${selectedCount === 1 ? '' : 's'} to ${fileName}`);
    } catch (error) {
      setState({ kind: 'error', message: errorMessage(error) });
    }
  };

  if (hideTrigger && !open) return null;

  return (
    <div className="board-export" ref={rootRef}>
      {!hideTrigger && (
        <button
          ref={triggerRef}
          type="button"
          className={`btn btn-sm${open ? ' active' : ''}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setInternalOpen((v) => !v)}
        >
          <Download className="icon" aria-hidden /> Export
        </button>
      )}
      {open && (
        <div id={panelId} className="board-export-dialog" role="dialog" aria-label="Export tickets">
          <div className="board-export-head">
            <h3 className="board-export-title">Export tickets</h3>
            <button type="button" className="icon-btn" aria-label="Close export" onClick={closePanel}>
              <X className="icon" aria-hidden />
            </button>
          </div>
          <fieldset className="board-export-group">
            <legend>Format</legend>
            {(['csv', 'json'] as const).map((f) => (
              <label key={f} className="board-export-option">
                <input
                  type="radio"
                  name={`${panelId}-format`}
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                />
                {f === 'csv' ? 'CSV' : 'JSON'}
              </label>
            ))}
          </fieldset>
          <fieldset className="board-export-group">
            <legend>Columns</legend>
            {columns.map((c) => (
              <label key={c.status} className="board-export-option">
                <input type="checkbox" checked={picked.has(c.status)} onChange={() => toggle(c.status)} />
                <span className="board-export-label">{c.label}</span>
                <span className="board-export-count">{counts.get(c.status) ?? 0}</span>
              </label>
            ))}
          </fieldset>
          {state.kind === 'error' && (
            <p className="board-export-error" role="alert">
              {state.message}
            </p>
          )}
          <div className="board-export-foot">
            <span className="board-export-total">
              {picked.size === 0 ? 'Pick at least one column' : `${selectedCount} tickets`}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={picked.size === 0 || state.kind === 'busy'}
              onClick={() => void run()}
            >
              {state.kind === 'busy' ? 'Exporting…' : 'Download'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
