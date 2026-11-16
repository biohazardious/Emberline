import type { ProjectRoadmapState } from '@emberline/protocol';
import { Bot, Sparkles, SquareCheck, SquareKanban, Target } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { SectionState } from '../SectionState';
import { MoreMenu, type MoreMenuItem, PageHeader } from '../ui';
import './roadmap-ux.css';

function MenuItemLabel({ itemId, children }: { itemId: string; children: ReactNode }) {
  return (
    <span
      ref={(el) => {
        const btn = el?.closest('[role="menuitem"]');
        if (btn) btn.id = itemId;
      }}
    >
      {children}
    </span>
  );
}

export function RoadmapHeaderPanel({
  projectName,
  roadmap,
  loading,
  loadError,
  onRetry,
  busy,
  isAgentBrainstorming,
  onAutoGenerate,
  onOpenBoard,
  quickAddTarget,
  onQuickAddTargetChange,
  quickAddText,
  onQuickAddTextChange,
  onSmartQuickAdd,
  selectedSuggestionsCount,
  selectedItemsCount,
  onClearSelection,
  onDispatchSelected,
  banner,
  error,
}: {
  projectName: string | undefined;
  roadmap: ProjectRoadmapState | undefined;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void | Promise<void>;
  busy: string | null;
  isAgentBrainstorming: boolean;
  onAutoGenerate: (mode: 'instant' | 'agent') => void;
  onOpenBoard: () => void;
  quickAddTarget: string;
  onQuickAddTargetChange: (next: string) => void;
  quickAddText: string;
  onQuickAddTextChange: (next: string) => void;
  onSmartQuickAdd: (e: FormEvent) => void;
  selectedSuggestionsCount: number;
  selectedItemsCount: number;
  onClearSelection: () => void;
  onDispatchSelected: (autoStart: boolean) => void;
  banner: string | null;
  error: string | null;
}) {
  const [visionExpanded, setVisionExpanded] = useState(false);
  const generateWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trigger = generateWrapRef.current?.querySelector<HTMLButtonElement>('.ui-more-trigger');
    if (!trigger) return;
    if (!trigger.classList.contains('btn-primary')) {
      trigger.classList.add('btn-primary');
    }
    const observer = new MutationObserver(() => {
      if (!trigger.classList.contains('btn-primary')) {
        trigger.classList.add('btn-primary');
      }
    });
    observer.observe(trigger, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [roadmap]);

  if (!roadmap) {
    return (
      <SectionState
        loading={loading}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading Interactive Roadmap & AI Brainstorming Studio…"
        emptyText="No roadmap initialized for this project yet."
        errorPrefix="Could not load Interactive Roadmap"
      />
    );
  }

  const totalSelected = selectedSuggestionsCount + selectedItemsCount;
  const agentItemLabel =
    busy === 'autogen-agent'
      ? 'Launching…'
      : isAgentBrainstorming
        ? 'Architect working…'
        : 'With the architect agent';

  const generateItems: MoreMenuItem[] = [
    {
      id: 'roadmap-autogen-instant-btn',
      icon: <Sparkles className="icon" aria-hidden="true" />,
      label: (
        <MenuItemLabel itemId="roadmap-autogen-instant-btn">
          {busy === 'autogen-instant' ? 'Generating…' : 'From PROJECT.md (instant)'}
        </MenuItemLabel>
      ),
      disabled: busy !== null,
      onSelect: () => onAutoGenerate('instant'),
    },
    {
      id: 'roadmap-autogen-agent-btn',
      icon: <Bot className="icon" aria-hidden="true" />,
      label: <MenuItemLabel itemId="roadmap-autogen-agent-btn">{agentItemLabel}</MenuItemLabel>,
      disabled: busy !== null || isAgentBrainstorming,
      onSelect: () => onAutoGenerate('agent'),
    },
  ];

  return (
    <section className="panel roadmap-header-panel">
      <PageHeader
        icon={<Target className="icon" aria-hidden="true" />}
        title="Roadmap"
        meta={
          <>
            <span className="badge">{projectName ?? 'Project'}</span>
            <span className="badge mono">
              {`${roadmap.completedItems}/${roadmap.totalItems} done (${roadmap.completionPercent}%)`}
            </span>
          </>
        }
        actions={
          <>
            <div className="roadmap-generate-wrap" ref={generateWrapRef}>
              <MoreMenu
                className="roadmap-generate-menu"
                label="Generate roadmap"
                ariaLabel="Generate roadmap"
                items={generateItems}
              />
            </div>
            <button type="button" className="btn btn-sm" onClick={onOpenBoard}>
              <SquareKanban className="icon" aria-hidden="true" /> Open board
            </button>
          </>
        }
      >
        {roadmap.visionSummary && (
          <div className="roadmap-vision-wrap">
            <p className={`muted roadmap-vision${visionExpanded ? ' is-expanded' : ' is-clamped'}`}>
              {roadmap.visionSummary}
            </p>
            <button
              type="button"
              className="btn btn-sm btn-ghost roadmap-vision-toggle"
              aria-expanded={visionExpanded}
              onClick={() => setVisionExpanded((prev) => !prev)}
            >
              {visionExpanded ? 'Show less' : 'Show more'}
            </button>
          </div>
        )}
      </PageHeader>

      <progress
        className="roadmap-progress"
        max={100}
        value={roadmap.completionPercent}
        aria-label="Roadmap completion"
      />

      <form className="roadmap-quick-add" onSubmit={onSmartQuickAdd}>
        <select
          aria-label="Quick Add Target"
          className="input mono roadmap-quick-target"
          value={quickAddTarget}
          onChange={(e) => onQuickAddTargetChange(e.target.value)}
        >
          <option value="auto">Auto-route</option>
          {roadmap.milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {`${m.code} — ${m.title.slice(0, 32)}`}
            </option>
          ))}
          <option value="__new_milestone__">New milestone</option>
        </select>
        <input
          id="roadmap-quick-add-input"
          className="input roadmap-quick-input"
          placeholder={
            quickAddTarget === '__new_milestone__' ? 'New milestone title…' : 'Add a roadmap item or feature…'
          }
          value={quickAddText}
          onChange={(e) => onQuickAddTextChange(e.target.value)}
        />
        <button type="submit" className="btn btn-sm" disabled={busy !== null || !quickAddText.trim()}>
          {busy === 'quick-add'
            ? 'Adding…'
            : quickAddTarget === '__new_milestone__'
              ? 'Add milestone'
              : 'Add item'}
        </button>
      </form>

      {totalSelected > 0 && (
        <div className="roadmap-selection-bar" role="region" aria-label="Selected roadmap items">
          <span className="mono roadmap-selection-count">
            <SquareCheck className="icon" aria-hidden="true" />
            {`${totalSelected} selected (${selectedSuggestionsCount} idea${selectedSuggestionsCount === 1 ? '' : 's'}, ${selectedItemsCount} item${selectedItemsCount === 1 ? '' : 's'})`}
          </span>
          <div className="roadmap-selection-actions">
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClearSelection}>
              Clear selection
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => onDispatchSelected(false)}
            >
              Send to board
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => onDispatchSelected(true)}
            >
              {busy === 'dispatch-run' ? 'Starting…' : 'Start on board'}
            </button>
          </div>
        </div>
      )}

      {banner && <div className="banner roadmap-banner">{banner}</div>}
      {error && (
        <div className="banner banner-error roadmap-banner" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
