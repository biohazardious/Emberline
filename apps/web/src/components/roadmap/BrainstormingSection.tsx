import type {
  BrainstormResponse,
  BrainstormSuggestion,
  DispatchRoadmapItemsResponse,
  ProjectRoadmapState,
  RoadmapCategory,
  Run,
} from '@emberline/protocol';
import { Bot, Brain, Rocket, Square, SquareCheck, Trash2, Zap } from 'lucide-react';
import { type CSSProperties, useMemo, useState } from 'react';
import { api } from '../../api';
import { ico, SectionState } from '../SectionState';
import {
  ActiveBrainstormRunBanner,
  BrainstormingEmptyState,
  BrainstormSuggestionCard,
} from './BrainstormSuggestionCard';
import {
  CATEGORY_META,
  RM_COL_10,
  RM_PANEL_COL,
  RM_ROW_WRAP6,
  RM_SUBBOX_ELEV,
  type RoadmapStudioCtx,
} from './roadmapMeta';

const HEAD_BTN_STYLE: CSSProperties = { fontSize: '0.74rem', padding: '3px 8px' };

export function BrainstormingSection({
  ctx,
  run,
  focus,
  setFocus,
  sel,
  toggle,
  setSel,
}: {
  ctx: RoadmapStudioCtx;
  run: Run | undefined;
  focus: string;
  setFocus: (value: string) => void;
  sel: Set<string>;
  toggle: (id: string) => void;
  setSel: (updater: (prev: Set<string>) => Set<string>) => void;
}) {
  const {
    base,
    proj,
    rm: roadmap,
    load,
    errObj,
    retry,
    provs,
    working,
    busy,
    setRm,
    onRun,
    route,
    setBanner,
    task,
  } = ctx;
  const [categoryFilter, setCategoryFilter] = useState<RoadmapCategory | 'all'>('all');

  const filteredSuggestions = useMemo(() => {
    const list = roadmap?.suggestions ?? [];
    return categoryFilter === 'all' ? list : list.filter((s) => s.category === categoryFilter);
  }, [roadmap?.suggestions, categoryFilter]);

  if (!roadmap) {
    return (
      <SectionState
        loading={load}
        error={errObj}
        onRetry={retry}
        loadingText="Loading brainstorming suggestions…"
        emptyText="No brainstorming suggestions available."
        errorPrefix="Could not load brainstorming suggestions"
      />
    );
  }

  const handleBrainstorm = (mode: 'instant' | 'agent') => {
    if (busy !== null || (mode === 'agent' && working)) return;
    return task(mode === 'agent' ? 'brainstorm-agent' : 'brainstorm-instant', async () => {
      const startedAt = Date.now();
      const res = await api<BrainstormResponse>(`${base}/brainstorm`, 'POST', {
        focus: focus.trim(),
        mode,
        leadPersona: 'product_owner',
      });
      const elapsed = Date.now() - startedAt;
      if (elapsed < 550) await new Promise((r) => setTimeout(r, 550 - elapsed));
      setRm(res.roadmap);
      if (mode === 'agent' && res.agentRun) {
        onRun(res.agentRun.id);
        setBanner(
          `Deep Brainstorming Agent (${res.agentRun.agent} · fable) is analyzing your codebase. New suggestions will appear automatically when it finishes.`,
        );
      } else {
        setBanner(
          `Synthesized fresh codebase-aware feature & architecture suggestions${focus.trim() ? ` for "${focus.trim()}"` : ''}.`,
        );
      }
    });
  };

  const handleQuickPromoteSuggestion = (sug: BrainstormSuggestion, autoStart: boolean) =>
    task(`sug-${sug.id}`, async () => {
      if (!autoStart) {
        const targetMs =
          roadmap.milestones.find((m) => m.code === sug.suggestedMilestoneCode) ??
          roadmap.milestones[1] ??
          roadmap.milestones[0];
        const next = await api<ProjectRoadmapState>(`${base}/items`, 'POST', {
          milestoneId: targetMs?.id ?? 'M2',
          title: sug.title,
          description: `${sug.rationale}\n\n---\nImplementation Spec:\n${sug.implementationPrompt}`,
          category: sug.category,
          persona: sug.persona,
          preferredAgent: sug.preferredAgent,
          preferredModel: sug.preferredModel,
          priority: sug.impact === 'high' ? 3 : 2,
          status: 'planned',
        });
        const afterDelete = await api<ProjectRoadmapState>(`${base}/items/${sug.id}`, 'DELETE');
        setRm(afterDelete ?? next);
        setBanner(`Added "${sug.title}" to Milestone ${targetMs?.code ?? 'M2'}.`);
      } else {
        const res = await api<DispatchRoadmapItemsResponse>(`${base}/dispatch`, 'POST', {
          suggestionIds: [sug.id],
          autoStart: true,
        });
        setRm(res.roadmap);
        setBanner(
          `Added "${sug.title}" to Roadmap, created Ticket ${res.createdTickets[0]?.key ?? ''}, and dispatched ${sug.preferredAgent} (${sug.preferredModel})!`,
        );
      }
    });

  const handleBuildAllSuggestions = () => {
    if (filteredSuggestions.length === 0 || busy !== null) return;
    return task('build-all-suggestions', async () => {
      const res = await api<DispatchRoadmapItemsResponse>(`${base}/dispatch`, 'POST', {
        suggestionIds: filteredSuggestions.map((s) => s.id),
        autoStart: true,
      });
      setRm(res.roadmap);
      setSel(() => new Set());
      setBanner(
        `Promoted all ${res.createdTickets.length} Brainstorming idea(s) to the Roadmap & Kanban Board and started the autonomous multi-agent pipeline!`,
      );
    });
  };

  const handleToggleSelectAllSuggestions = () => {
    const visibleIds = filteredSuggestions.map((s) => s.id);
    if (visibleIds.length === 0) return;
    const allSelected = visibleIds.every((id) => sel.has(id));
    setSel((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const handleDismissSuggestion = (sugId: string) =>
    task(
      null,
      async () => {
        setRm(await api<ProjectRoadmapState>(`${base}/items/${sugId}`, 'DELETE'));
      },
      false,
    );

  const handleClearAllSuggestions = () =>
    task(
      null,
      async () => {
        setRm(await api<ProjectRoadmapState>(`${base}/items/__all_suggestions__`, 'DELETE'));
        setSel(() => new Set());
      },
      false,
    );

  return (
    <section className="panel" style={RM_PANEL_COL}>
      <header className="panel-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>{ico(Brain)} AI Brainstorming &amp; Feature Suggestions</h2>
          <p className="muted">
            Explore what to build next, customize each idea&apos;s CLI agent &amp; model route inline, or
            launch all ideas at once.
          </p>
        </div>
        <div style={RM_ROW_WRAP6}>
          <span className="badge mono">{filteredSuggestions.length} ideas</span>
          {filteredSuggestions.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={HEAD_BTN_STYLE}
                onClick={handleToggleSelectAllSuggestions}
                title="Select or deselect all visible brainstorming suggestions"
              >
                {filteredSuggestions.every((s) => sel.has(s.id)) ? (
                  <>{ico(Square)} Deselect All</>
                ) : (
                  <>{ico(SquareCheck)} Select All</>
                )}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={HEAD_BTN_STYLE}
                disabled={busy !== null}
                onClick={() => void handleClearAllSuggestions()}
                title="Clear all current brainstorming suggestions"
              >
                {ico(Trash2)} Clear
              </button>
              <button
                id="brainstorm-build-all-btn"
                type="button"
                className="btn btn-sm btn-primary"
                style={{ fontSize: '0.74rem', padding: '3px 10px' }}
                disabled={busy !== null}
                onClick={() => void handleBuildAllSuggestions()}
                title="Create Kanban tickets for all visible suggestions and start autonomous execution"
              >
                {busy === 'build-all-suggestions' ? (
                  'Starting All…'
                ) : (
                  <>
                    {ico(Rocket)} Build All ({filteredSuggestions.length})
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </header>

      <div style={RM_SUBBOX_ELEV}>
        <input
          id="brainstorm-focus-input"
          className="input"
          placeholder="Optional brainstorm focus (leave empty for general project analysis, or type a topic and press Enter)…"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleBrainstorm('instant');
            }
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div className="segmented" style={{ fontSize: '0.74rem' }}>
            <button
              type="button"
              className={categoryFilter === 'all' ? 'active' : ''}
              onClick={() => setCategoryFilter('all')}
            >
              All
            </button>
            {(Object.keys(CATEGORY_META) as RoadmapCategory[]).map((cat) => (
              <button
                key={cat}
                type="button"
                className={categoryFilter === cat ? 'active' : ''}
                onClick={() => setCategoryFilter(cat)}
              >
                {CATEGORY_META[cat].icon} {CATEGORY_META[cat].label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              id="brainstorm-instant-btn"
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void handleBrainstorm('instant')}
              title="Analyze PROJECT.md & project domain to synthesize instant suggestions"
            >
              {busy === 'brainstorm-instant' ? 'Synthesizing…' : <>{ico(Zap)} Synthesize Ideas</>}
            </button>
            <button
              id="brainstorm-agent-btn"
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null || working}
              onClick={() => void handleBrainstorm('agent')}
              title={
                working
                  ? 'A Deep Brainstorming Agent is already running for this project'
                  : 'Launch a Product Owner (Claude Fable) agent to deeply inspect the codebase and write new suggestions'
              }
            >
              {busy === 'brainstorm-agent' ? (
                'Launching…'
              ) : working ? (
                <>{ico(Brain)} Brainstorming in Progress…</>
              ) : (
                <>{ico(Bot)} Deep Agent Brainstorm</>
              )}
            </button>
          </div>
        </div>

        {run && <ActiveBrainstormRunBanner run={run} />}
      </div>

      <div style={RM_COL_10}>
        {filteredSuggestions.map((sug) => (
          <BrainstormSuggestionCard
            key={sug.id}
            sug={sug}
            checked={sel.has(sug.id)}
            provs={provs}
            busy={busy}
            onToggle={() => toggle(sug.id)}
            onDismiss={() => void handleDismissSuggestion(sug.id)}
            onRoute={(nextAgent, nextModel) => route(sug.id, nextAgent, nextModel)}
            onPromote={(autoStart) => void handleQuickPromoteSuggestion(sug, autoStart)}
          />
        ))}

        {filteredSuggestions.length === 0 && <BrainstormingEmptyState name={proj?.name} working={working} />}
      </div>
    </section>
  );
}
