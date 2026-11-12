import type { AgentId, AgentModelId, BrainstormSuggestion, RoadmapCategory, Run } from '@emberline/protocol';
import { Bot, Brain, Rocket, Square, SquareCheck, Trash2, Zap } from 'lucide-react';
import { Link } from 'wouter';
import { PersonaBadge } from '../PersonaBadge';
import { CATEGORY_META, RouteBadgeSelect } from './RoadmapBadges';

export function BrainstormingColumn({
  projectName,
  filteredSuggestions,
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
  return (
    <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header className="panel-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>
            <Brain className="icon" aria-hidden /> AI Brainstorming &amp; Feature Suggestions
          </h2>
          <p className="muted">
            Explore what to build next, customize each idea&apos;s CLI agent &amp; model route inline, or
            launch all ideas at once.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className="badge mono">{filteredSuggestions.length} ideas</span>
          {filteredSuggestions.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ fontSize: '0.74rem', padding: '3px 8px' }}
                onClick={onToggleSelectAllSuggestions}
                title="Select or deselect all visible brainstorming suggestions"
              >
                {filteredSuggestions.every((s) => selectedSuggestions.has(s.id)) ? (
                  <>
                    <Square className="icon" aria-hidden /> Deselect All
                  </>
                ) : (
                  <>
                    <SquareCheck className="icon" aria-hidden /> Select All
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ fontSize: '0.74rem', padding: '3px 8px' }}
                disabled={busy !== null}
                onClick={onClearAllSuggestions}
                title="Clear all current brainstorming suggestions"
              >
                <Trash2 className="icon" aria-hidden /> Clear
              </button>
              <button
                id="brainstorm-build-all-btn"
                type="button"
                className="btn btn-sm btn-primary"
                style={{ fontSize: '0.74rem', padding: '3px 10px' }}
                disabled={busy !== null}
                onClick={onBuildAllSuggestions}
                title="Create Kanban tickets for all visible suggestions and start autonomous execution"
              >
                {busy === 'build-all-suggestions' ? (
                  'Starting All…'
                ) : (
                  <>
                    <Rocket className="icon" aria-hidden /> Build All ({filteredSuggestions.length})
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </header>

      <div
        style={{
          padding: 10,
          borderRadius: 'var(--radius)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <input
          id="brainstorm-focus-input"
          className="input"
          placeholder="Optional brainstorm focus (leave empty for general project analysis, or type a topic and press Enter)…"
          value={brainstormFocus}
          onChange={(e) => onBrainstormFocusChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onBrainstorm('instant');
            }
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div className="segmented segmented-scroll" style={{ fontSize: '0.74rem' }}>
            <button
              type="button"
              className={categoryFilter === 'all' ? 'active' : ''}
              onClick={() => onCategoryFilterChange('all')}
            >
              All
            </button>
            {(Object.keys(CATEGORY_META) as RoadmapCategory[]).map((cat) => (
              <button
                key={cat}
                type="button"
                className={categoryFilter === cat ? 'active' : ''}
                onClick={() => onCategoryFilterChange(cat)}
              >
                {CATEGORY_META[cat].icon} {CATEGORY_META[cat].label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              id="brainstorm-instant-btn"
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => onBrainstorm('instant')}
              title="Analyze PROJECT.md & project domain to synthesize instant suggestions"
            >
              {busy === 'brainstorm-instant' ? (
                'Synthesizing…'
              ) : (
                <>
                  <Zap className="icon" aria-hidden /> Synthesize Ideas
                </>
              )}
            </button>
            <button
              id="brainstorm-agent-btn"
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null || isAgentBrainstorming}
              onClick={() => onBrainstorm('agent')}
              title={
                isAgentBrainstorming
                  ? 'A Deep Brainstorming Agent is already running for this project'
                  : 'Launch a Product Owner (Claude Fable) agent to deeply inspect the codebase and write new suggestions'
              }
            >
              {busy === 'brainstorm-agent' ? (
                'Launching…'
              ) : isAgentBrainstorming ? (
                <>
                  <Brain className="icon" aria-hidden /> Brainstorming in Progress…
                </>
              ) : (
                <>
                  <Bot className="icon" aria-hidden /> Deep Agent Brainstorm
                </>
              )}
            </button>
          </div>
        </div>

        {activeBrainstormRun && (
          <div
            style={{
              marginTop: 4,
              padding: '6px 10px',
              borderRadius: 'var(--radius)',
              background: 'color-mix(in srgb, var(--violet) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--violet) 40%, transparent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: '0.78rem',
            }}
          >
            <span className="mono">
              <span className="dot run-working" style={{ marginRight: 6 }} />
              Deep Brainstorming Agent ({activeBrainstormRun.agent} · fable) is inspecting the repository…
            </span>
            {activeBrainstormRun.terminalId && (
              <Link
                href={`/terminals/${activeBrainstormRun.terminalId}`}
                className="btn btn-sm btn-ghost mono"
                style={{ fontSize: '0.72rem', padding: '2px 8px' }}
              >
                View Terminal →
              </Link>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filteredSuggestions.map((sug) => {
          const checked = selectedSuggestions.has(sug.id);
          const cat = CATEGORY_META[sug.category] ?? CATEGORY_META.feature;
          return (
            <div
              key={sug.id}
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius)',
                background: checked
                  ? 'color-mix(in srgb, var(--ember-1) 8%, transparent)'
                  : 'var(--bg-elevated)',
                border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: '0.88rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleSuggestion(sug.id)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    {cat.icon} {sug.title}
                  </span>
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  title="Dismiss suggestion"
                  onClick={() => onDismissSuggestion(sug.id)}
                >
                  ×
                </button>
              </div>

              <p className="muted" style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.45 }}>
                {sug.rationale}
              </p>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  flexWrap: 'wrap',
                  paddingTop: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge mono" style={{ fontSize: '0.68rem' }}>
                    Target: {sug.suggestedMilestoneCode}
                  </span>
                  <PersonaBadge persona={sug.persona} />
                  <RouteBadgeSelect
                    agent={sug.preferredAgent}
                    model={sug.preferredModel}
                    persona={sug.persona}
                    enabledProviders={enabledProviders}
                    disabled={busy !== null}
                    onChange={(nextAgent, nextModel) => onChangeRoute(sug.id, nextAgent, nextModel)}
                  />
                  <span className="badge mono" style={{ fontSize: '0.68rem' }}>
                    Impact: {sug.impact.toUpperCase()}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy !== null}
                    onClick={() => onQuickPromoteSuggestion(sug, false)}
                    title={`Add to Milestone ${sug.suggestedMilestoneCode} without starting a run yet`}
                  >
                    + Add to {sug.suggestedMilestoneCode}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null}
                    onClick={() => onQuickPromoteSuggestion(sug, true)}
                    title="Add to Roadmap, create Kanban ticket, and start the specialist agent immediately"
                  >
                    {busy === `sug-${sug.id}` ? (
                      'Starting…'
                    ) : (
                      <>
                        <Rocket className="icon" aria-hidden /> Build Now
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {filteredSuggestions.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: '24px 16px',
              borderRadius: 'var(--radius)',
              border: '1px dashed var(--border)',
              background: 'var(--bg)',
            }}
          >
            {isAgentBrainstorming ? (
              <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
                <Brain className="icon" aria-hidden /> <strong>Deep Brainstorming Agent</strong> is analyzing{' '}
                <strong>{projectName ?? 'this project'}</strong>… Tailored suggestions will automatically
                appear here as soon as analysis finishes.
              </p>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
                Brainstorming list is empty. Click{' '}
                <strong>
                  <Bot className="icon" aria-hidden /> Deep Agent Brainstorm
                </strong>{' '}
                (for full AI codebase analysis) or{' '}
                <strong>
                  <Zap className="icon" aria-hidden /> Synthesize Ideas
                </strong>{' '}
                above to populate suggestions tailored to <strong>{projectName ?? 'this project'}</strong>.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
