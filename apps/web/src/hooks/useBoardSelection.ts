import type { Ticket } from '@emberline/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addAll,
  allSelected,
  type BoardSelection,
  EMPTY_SELECTION,
  pruneSelection,
  selectRange,
  toggleSelected,
} from '../boardSelection';

export interface BoardSelectionState {
  /** Selection mode is on: cards pick instead of open, and dragging is off. */
  active: boolean;
  selection: BoardSelection;
  isSelected: (id: string) => boolean;
  /** `range`: shift-click, picks every visible card since the last pick. */
  toggle: (id: string, range: boolean) => void;
  /** Picks a column's visible cards, or drops them when all are picked already. */
  toggleColumn: (ids: readonly string[]) => void;
  columnSelected: (ids: readonly string[]) => boolean;
  replace: (next: BoardSelection) => void;
  setActive: (on: boolean) => void;
}

/** Selection mode of the board; `ordered` is every visible card in board order. */
export function useBoardSelection(
  tickets: readonly Ticket[] | undefined,
  ordered: readonly string[],
): BoardSelectionState {
  const [active, setActiveState] = useState(false);
  const [selection, setSelection] = useState<BoardSelection>(EMPTY_SELECTION);
  const anchor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (tickets) setSelection((prev) => pruneSelection(prev, tickets));
  }, [tickets]);

  const toggle = useCallback(
    (id: string, range: boolean) => {
      setSelection((prev) =>
        range ? selectRange(prev, ordered, anchor.current, id) : toggleSelected(prev, id),
      );
      anchor.current = id;
    },
    [ordered],
  );

  const toggleColumn = useCallback((ids: readonly string[]) => {
    setSelection((prev) =>
      allSelected(prev, ids) ? prev.filter((id) => !ids.includes(id)) : addAll(prev, ids),
    );
  }, []);

  const setActive = useCallback((on: boolean) => {
    setActiveState(on);
    if (!on) {
      setSelection(EMPTY_SELECTION);
      anchor.current = undefined;
    }
  }, []);

  return {
    active,
    selection,
    isSelected: (id) => selection.includes(id),
    toggle,
    toggleColumn,
    columnSelected: (ids) => allSelected(selection, ids),
    replace: setSelection,
    setActive,
  };
}
