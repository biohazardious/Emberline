import type { AgentId, AgentModelId, BrainstormSuggestion, RoadmapCategory, Run } from '@emberline/protocol';
import { Bot, Rocket, Square, SquareCheck, Trash2, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { PersonaBadge } from '../PersonaBadge';
import { SectionState } from '../SectionState';
import { MoreMenu, type MoreMenuItem } from '../ui';
import { CATEGORY_META, RouteBadgeSelect } from './RoadmapBadges';
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

export function BrainstormingColumn({
  projectName,
  filteredSuggestions,
  loading,
  loadError,
  onRetry,
  selectedSuggestions,
  onToggleSuggestion,
  onToggleSelectAllSuggestions,
  onClearAllSuggestions,
  onBuildAllSuggestions,
  brainstormFocus,
  onBrainstormFocusChange,
  categoryFilter,
  onCategoryFilterChange,
  onBrainstorm,
  busy,
  isAgentBrainstorming,
  activeBrainstormRun,
  enabledProviders,
  onChangeRoute,
  onQuickPromoteSuggestion,
  onDismissSuggestion,
}: {
  projectName: string | undefined;
  filteredSuggestions: BrainstormSuggestion[];
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void | Promise<void>;
  selectedSuggestions: ReadonlySet<string>;
  onToggleSuggestion: (id: string) => void;
  onToggleSelectAllSuggestions: () => void;
  onClearAllSuggestions: () => void;
  onBuildAllSuggestions: () => void;
  brainstormFocus: string;
  onBrainstormFocusChange: (next: string) => void;
  categoryFilter: RoadmapCategory | 'all';
  onCategoryFilterChange: (next: RoadmapCategory | 'all') => void;
  onBrainstorm: (mode: 'instant' | 'agent') => void;
  busy: string | null;
  isAgentBrainstorming: boolean;
  activeBrainstormRun: Run | undefined;
  enabledProviders: AgentId[];
  onChangeRoute: (id: string, agent: AgentId, model: AgentModelId) => void;
  onQuickPromoteSuggestion: (sug: BrainstormSuggestion, autoStart: boolean) => void;
  onDismissSuggestion: (id: string) => void;
}) {
  if (loading || loadError !== undefined) {
    return (
      <SectionState
        loading={loading}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading AI brainstorming suggestions…"
        errorPrefix="Could not load brainstorming suggestions"
      />
    );
  }

  const allSelected =
    filteredSuggestions.length > 0 && filteredSuggestions.every((s) => selectedSuggestions.has(s.id));

  const moreItems: MoreMenuItem[] = [
    {
      id: 'brainstorm-agent-btn',
      icon: <Bot className="icon" aria-hidden="true" />,
      label: (
        <MenuItemLabel itemId="brainstorm-agent-btn">
          {busy === 'brainstorm-agent' ? 'Launching…' : isAgentBrainstorming ? 'Agent working…' : 'Ask agent'}
        </MenuItemLabel>
      ),
      disabled: busy !== null || isAgentBrainstorming,
      onSelect: () => onBrainstorm('agent'),
    },
    ...(filteredSuggestions.length > 0
      ? ([
          {
            id: 'brainstorm-select-all-btn',
            icon: allSelected ? (
              <Square className="icon" aria-hidden="true" />
            ) : (
              <SquareCheck className="icon" aria-hidden="true" />
            ),
            label: allSelected ? 'Deselect all' : 'Select all',
            onSelect: onToggleSelectAllSuggestions,
          },
          {
            id: 'brainstorm-build-all-btn',
            icon: <Rocket className="icon" aria-hidden="true" />,
            label: (
              <MenuItemLabel itemId="brainstorm-build-all-btn">
                {busy === 'build-all-suggestions' ? 'Starting…' : 'Build all'}
              </MenuItemLabel>
            ),
            disabled: busy !== null,
            onSelect: onBuildAllSuggestions,
          },
          {
            id: 'brainstorm-clear-btn',
            icon: <Trash2 className="icon" aria-hidden="true" />,
            label: 'Clear ideas',
            danger: true,
            disabled: busy !== null,
            onSelect: onClearAllSuggestions,
          },
        ] satisfies MoreMenuItem[])
      : []),
  ];

  return (
    <section className="panel roadmap-column">
      <header className="panel-head roadmap-column-head">
        <h2 className="roadmap-column-title">Ideas</h2>
        <div className="roadmap-column-actions">
          <span className="badge mono roadmap-count-badge">{`${filteredSuggestions.length} ideas`}</span>
          <MoreMenu label="More" ariaLabel="More idea actions" items={moreItems} />
        </div>
      </header>

      <div className="roadmap-ideas-prompt">
        <div className="roadmap-ideas-bar">
          <input
            id="brainstorm-focus-input"
            className="input roadmap-ideas-input"
            placeholder="Focus topic (optional)…"
            value={brainstormFocus}
            onChange={(e) => onBrainstormFocusChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onBrainstorm('instant');
              }
            }}
          />
          <select
            aria-label="Filter ideas by category"
            className="input mono roadmap-ideas-category"
            value={categoryFilter}
            onChange={(e) => onCategoryFilterChange(e.target.value as RoadmapCategory | 'all')}
          >
            <option value="all">All categories</option>
            {(Object.keys(CATEGORY_META) as RoadmapCategory[]).map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_META[cat].label}
              </option>
            ))}
          </select>
          <button
            id="brainstorm-instant-btn"
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={() => onBrainstorm('instant')}
          >
            {busy === 'brainstorm-instant' ? (
              'Suggesting…'
            ) : (
              <>
                <Zap className="icon" aria-hidden="true" /> Suggest ideas
              </>
            )}
          </button>
        </div>

        {activeBrainstormRun && (
          <div className="roadmap-agent-banner">
            <span className="mono roadmap-agent-status">
              <span className="dot run-working" aria-hidden="true" />
              {`Agent (${activeBrainstormRun.agent}) is inspecting the repository…`}
            </span>
            {activeBrainstormRun.terminalId && (
              <Link
                href={`/terminals/${activeBrainstormRun.terminalId}`}
                className="btn btn-sm btn-ghost mono"
              >
                Open terminal
              </Link>
            )}
          </div>
        )}
      </div>

      <div className="roadmap-idea-list">
        {filteredSuggestions.map((sug) => {
          const checked = selectedSuggestions.has(sug.id);
          const cat = CATEGORY_META[sug.category] ?? CATEGORY_META.feature;
          return (
            <div key={sug.id} className={`roadmap-idea-row${checked ? ' is-selected' : ''}`}>
              <div className="roadmap-idea-head">
                <label className="roadmap-idea-label">
                  <input
                    type="checkbox"
                    className="roadmap-idea-checkbox"
                    checked={checked}
                    onChange={() => onToggleSuggestion(sug.id)}
                  />
                  <span>
                    {cat.icon} {sug.title}
                  </span>
                </label>
              </div>

              <p className="muted roadmap-idea-rationale">{sug.rationale}</p>

              <div className="roadmap-idea-foot">
                <div className="roadmap-idea-badges">
                  <span className="badge mono roadmap-meta-badge">{sug.suggestedMilestoneCode}</span>
                  <PersonaBadge persona={sug.persona} />
                  <RouteBadgeSelect
                    agent={sug.preferredAgent}
                    model={sug.preferredModel}
                    persona={sug.persona}
                    enabledProviders={enabledProviders}
                    disabled={busy !== null}
                    onChange={(nextAgent, nextModel) => onChangeRoute(sug.id, nextAgent, nextModel)}
                  />
                  <span className="badge mono roadmap-meta-badge">{`${sug.impact} impact`}</span>
                </div>

                <div className="roadmap-idea-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy !== null}
                    onClick={() => onQuickPromoteSuggestion(sug, false)}
                  >
                    Add to roadmap
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy !== null}
                    onClick={() => onDismissSuggestion(sug.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {filteredSuggestions.length === 0 && (
          <div className="roadmap-empty">
            {isAgentBrainstorming ? (
              <p className="muted roadmap-empty-text">
                {`Brainstorming agent is analyzing ${projectName ?? 'this project'}…`}
              </p>
            ) : (
              <p className="muted roadmap-empty-text">
                {`Brainstorming list is empty. Use Suggest ideas above to generate ideas for ${projectName ?? 'this project'}.`}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
