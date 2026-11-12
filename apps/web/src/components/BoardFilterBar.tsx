import type { Run, Ticket, TicketStatus } from '@emberline/protocol';
import { Activity, Lock, Search, X } from 'lucide-react';
import { useMemo } from 'react';
import {
  type BoardFilter,
  countBoardFlags,
  countBoardPersonas,
  EMPTY_BOARD_FILTER,
  isBoardFilterActive,
} from '../boardFilter';
import { toggled } from '../roadmapFilter';
import { PERSONA_LIST } from './PersonaBadge';

const PRIORITY_FILTER_META: ReadonlyArray<{ value: number; label: string }> = [
  { value: 3, label: 'Urgent' },
  { value: 2, label: 'High' },
];

export function SearchInput({
  id,
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={`search-field${className ? ` ${className}` : ''}`}>
      <Search className="icon search-field-icon" aria-hidden />
      <input
        id={id}
        type="search"
        className="input search-field-input"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value.length > 0 && (
        <button
          type="button"
          className="icon-btn search-field-clear"
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          title="Clear search (Esc)"
          onClick={() => onChange('')}
        >
          <X className="icon" aria-hidden />
        </button>
      )}
    </div>
  );
}

export function BoardFilterBar({
  tickets,
  latestRunByTicket,
  filter,
  shown,
  onChange,
}: {
  tickets: readonly Ticket[];
  latestRunByTicket: ReadonlyMap<string, Run>;
  filter: BoardFilter;
  shown: number;
  onChange: (next: BoardFilter) => void;
}) {
  const personaCounts = useMemo(() => countBoardPersonas(tickets), [tickets]);
  const flags = useMemo(() => countBoardFlags(tickets, latestRunByTicket), [tickets, latestRunByTicket]);
  const priorityCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const ticket of tickets) counts.set(ticket.priority, (counts.get(ticket.priority) ?? 0) + 1);
    return counts;
  }, [tickets]);

  const active = isBoardFilterActive(filter);
  const visiblePersonas = PERSONA_LIST.filter(
    (p) => personaCounts[p.id] > 0 || filter.personas.includes(p.id),
  );
  const visiblePriorities = PRIORITY_FILTER_META.filter(
    (p) => (priorityCounts.get(p.value) ?? 0) > 0 || filter.priorities.includes(p.value),
  );

  return (
    <div className="board-filter" role="search" aria-label="Filter board tickets">
      <SearchInput
        id="board-search"
        className="board-search"
        ariaLabel="Filter tickets"
        placeholder="Filter by key, title, branch, label…"
        value={filter.query}
        onChange={(query) => onChange({ ...filter, query })}
      />

      {visiblePersonas.length > 0 && (
        <div className="board-filter-group" role="group" aria-label="Filter by persona">
          {visiblePersonas.map((p) => {
            const pressed = filter.personas.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`chip-btn${pressed ? ' active' : ''}`}
                aria-pressed={pressed}
                title={p.hint}
                onClick={() => onChange({ ...filter, personas: toggled(filter.personas, p.id) })}
              >
                {p.shortLabel}
                <span className="board-filter-count mono">{personaCounts[p.id]}</span>
              </button>
            );
          })}
        </div>
      )}

      {(flags.activeRun > 0 ||
        filter.onlyActiveRun ||
        flags.blocked > 0 ||
        filter.onlyBlocked ||
        visiblePriorities.length > 0) && (
        <div className="board-filter-group" role="group" aria-label="Filter by state and priority">
          {(flags.activeRun > 0 || filter.onlyActiveRun) && (
            <button
              type="button"
              className={`chip-btn${filter.onlyActiveRun ? ' active' : ''}`}
              aria-pressed={filter.onlyActiveRun}
              onClick={() => onChange({ ...filter, onlyActiveRun: !filter.onlyActiveRun })}
            >
              <Activity className="icon" aria-hidden /> Live
              <span className="board-filter-count mono">{flags.activeRun}</span>
            </button>
          )}
          {(flags.blocked > 0 || filter.onlyBlocked) && (
            <button
              type="button"
              className={`chip-btn${filter.onlyBlocked ? ' active' : ''}`}
              aria-pressed={filter.onlyBlocked}
              onClick={() => onChange({ ...filter, onlyBlocked: !filter.onlyBlocked })}
            >
              <Lock className="icon" aria-hidden /> Blocked
              <span className="board-filter-count mono">{flags.blocked}</span>
            </button>
          )}
          {visiblePriorities.map((p) => {
            const pressed = filter.priorities.includes(p.value);
            return (
              <button
                key={p.value}
                type="button"
                className={`chip-btn${pressed ? ' active' : ''}`}
                aria-pressed={pressed}
                onClick={() => onChange({ ...filter, priorities: toggled(filter.priorities, p.value) })}
              >
                {p.label}
                <span className="board-filter-count mono">{priorityCounts.get(p.value) ?? 0}</span>
              </button>
            );
          })}
        </div>
      )}

      {active && (
        <div className="board-filter-status">
          <span className="muted small mono">
            {shown} of {tickets.length}
          </span>
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => onChange(EMPTY_BOARD_FILTER)}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

export function MobileColumnNav({
  columns,
  counts,
}: {
  columns: ReadonlyArray<{ status: TicketStatus; label: string }>;
  counts: ReadonlyMap<TicketStatus, number>;
}) {
  const jumpToColumn = (status: TicketStatus) => {
    const el = document.getElementById(`col-${status}`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };

  return (
    <nav className="mobile-col-nav" aria-label="Jump to board column">
      {columns.map((col) => (
        <button
          key={col.status}
          type="button"
          className="chip-btn mobile-col-chip"
          onClick={() => jumpToColumn(col.status)}
        >
          <span>{col.label}</span>
          <span className="board-filter-count mono">{counts.get(col.status) ?? 0}</span>
        </button>
      ))}
    </nav>
  );
}
