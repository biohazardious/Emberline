import type { ProjectRoadmapState } from '@emberline/protocol';
import { Bot, Inbox, Landmark, Rocket, Sparkles, SquareCheck, SquareKanban, Target } from 'lucide-react';
import type { FormEvent } from 'react';
import { SectionState } from '../SectionState';

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

  return (
    <section className="panel" style={{ padding: '14px 16px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
              <Target className="icon" aria-hidden /> {projectName ?? 'Project'} — Roadmap, Milestones &amp;
              AI Brainstorming Studio
            </h2>
            <span className="badge mono">
              {roadmap.completedItems}/{roadmap.totalItems} completed ({roadmap.completionPercent}%)
            </span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: '0.82rem', maxWidth: 820 }}>
            {roadmap.visionSummary}
          </p>
        </div>

        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            id="roadmap-autogen-instant-btn"
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={() => onAutoGenerate('instant')}
            title="Automatically synthesize domain-tailored milestones & roadmap tasks from PROJECT.md and codebase"
          >
            {busy === 'autogen-instant' ? (
              'Generating…'
            ) : (
              <>
                <Sparkles className="icon" aria-hidden /> Auto-Generate Roadmap
              </>
            )}
          </button>
          <button
            id="roadmap-autogen-agent-btn"
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy !== null || isAgentBrainstorming}
            onClick={() => onAutoGenerate('agent')}
            title="Dispatch the System Architect agent to inspect the repository and generate a full custom milestone roadmap"
          >
            {busy === 'autogen-agent' ? (
              'Launching…'
            ) : isAgentBrainstorming ? (
              <>
                <Landmark className="icon" aria-hidden /> Architect Working…
              </>
            ) : (
              <>
                <Bot className="icon" aria-hidden /> AI Architect Roadmap
              </>
            )}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenBoard}>
            <SquareKanban className="icon" aria-hidden /> Open Kanban Board
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          style={{
            width: '100%',
            height: 8,
            borderRadius: 999,
            background: 'var(--bg)',
            overflow: 'hidden',
            border: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              width: `${roadmap.completionPercent}%`,
              height: '100%',
              background: 'var(--ok)',
              transition: 'width 250ms ease',
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {roadmap.milestones.map((ms) => {
            const doneCount = ms.items.filter((i) => i.status === 'done').length;
            return (
              <span
                key={ms.id}
                className="badge mono"
                style={{
                  fontSize: '0.73rem',
                  borderColor:
                    ms.status === 'completed'
                      ? 'color-mix(in srgb, var(--ok) 45%, transparent)'
                      : ms.status === 'active'
                        ? 'var(--accent)'
                        : 'var(--border)',
                  color:
                    ms.status === 'completed'
                      ? 'var(--ok)'
                      : ms.status === 'active'
                        ? 'var(--text)'
                        : 'var(--muted)',
                }}
              >
                {ms.status === 'completed' ? '✓ ' : ms.status === 'active' ? '● ' : '○ '}
                {ms.code}: {ms.title} ({doneCount}/{ms.items.length})
              </span>
            );
          })}
        </div>
      </div>

      <form
        onSubmit={onSmartQuickAdd}
        style={{
          marginTop: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '8px 10px',
          borderRadius: 'var(--radius)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
        }}
      >
        <select
          aria-label="Quick Add Target"
          className="input mono"
          style={{ width: 230, fontSize: '0.78rem', padding: '6px 8px' }}
          value={quickAddTarget}
          onChange={(e) => onQuickAddTargetChange(e.target.value)}
          title="Choose where to add: Smart Auto-Route automatically selects the milestone, specialist persona, and model!"
        >
          <option value="auto">Smart Auto-Route (Recommended)</option>
          {roadmap.milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code} — {m.title.slice(0, 32)}
            </option>
          ))}
          <option value="__new_milestone__">Create as New Milestone Phase</option>
        </select>
        <input
          id="roadmap-quick-add-input"
          className="input grow"
          style={{ minWidth: 240 }}
          placeholder={
            quickAddTarget === '__new_milestone__'
              ? 'Type new milestone title (e.g. "Multiplayer & Cloud Sync") and press Enter…'
              : 'Type any feature or task in plain language and press Enter — AI auto-assigns Milestone, Persona & Model…'
          }
          value={quickAddText}
          onChange={(e) => onQuickAddTextChange(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={busy !== null || !quickAddText.trim()}
        >
          {busy === 'quick-add'
            ? 'Adding…'
            : quickAddTarget === '__new_milestone__'
              ? '+ Add Milestone'
              : '+ Quick Add'}
        </button>
      </form>

      {totalSelected > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 'var(--radius)',
            background: 'color-mix(in srgb, var(--ember-1) 10%, transparent)',
            border: '1px solid var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span className="mono" style={{ fontSize: '0.82rem', fontWeight: 600 }}>
            <SquareCheck className="icon" aria-hidden /> {totalSelected} selected ({selectedSuggestionsCount}{' '}
            suggestion
            {selectedSuggestionsCount === 1 ? '' : 's'}, {selectedItemsCount} roadmap item
            {selectedItemsCount === 1 ? '' : 's'})
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClearSelection}>
              Clear Selection
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => onDispatchSelected(false)}
            >
              <Inbox className="icon" aria-hidden /> Create Ready Tickets on Board
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null}
              onClick={() => onDispatchSelected(true)}
            >
              {busy === 'dispatch-run' ? (
                'Dispatching…'
              ) : (
                <>
                  <Rocket className="icon" aria-hidden /> Create Tickets &amp; Auto-Dispatch Multi-Agent
                  Pipeline
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {banner && (
        <div className="banner" style={{ marginTop: 10 }}>
          {banner}
        </div>
      )}
      {error && (
        <div className="banner banner-error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </section>
  );
}
