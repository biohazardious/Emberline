import type {
  AutoGenerateRoadmapResponse,
  DispatchRoadmapItemsResponse,
  ProjectRoadmapState,
} from '@emberline/protocol';
import { Bot, Inbox, Landmark, Rocket, Sparkles, SquareCheck, SquareKanban, Target } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../../api';
import { ico, SectionState } from '../SectionState';
import { RM_HEAD_SPLIT, RM_ROW_BETWEEN, RM_ROW_WRAP8, type RoadmapStudioCtx } from './roadmapMeta';

export function RoadmapHeaderSection({
  ctx,
  focus,
  sugIds,
  itemIds,
  clear,
}: {
  ctx: RoadmapStudioCtx;
  focus: string;
  sugIds: string[];
  itemIds: string[];
  clear: () => void;
}) {
  const {
    pid,
    base,
    proj,
    rm: roadmap,
    load,
    errObj,
    retry,
    busy,
    working,
    setRm,
    onRun,
    banner,
    setBanner,
    err,
    task,
  } = ctx;
  const [, navigate] = useLocation();
  const [quickAddText, setQuickAddText] = useState('');
  const [quickAddTarget, setQuickAddTarget] = useState<string>('auto');

  if (!roadmap) {
    return (
      <SectionState
        loading={load}
        error={errObj}
        onRetry={retry}
        loadingText="Loading Interactive Roadmap & AI Brainstorming Studio…"
        emptyText="No roadmap data available for this project yet."
        errorPrefix="Could not load roadmap"
      />
    );
  }

  const totalSelected = sugIds.length + itemIds.length;

  const handleAutoGenerateRoadmap = (mode: 'instant' | 'agent') => {
    if (busy !== null || (mode === 'agent' && working)) return;
    return task(mode === 'agent' ? 'autogen-agent' : 'autogen-instant', async () => {
      const res = await api<AutoGenerateRoadmapResponse>(`${base}/auto-generate`, 'POST', {
        mode,
        instructions: quickAddText.trim() || focus.trim(),
      });
      setRm(res.roadmap);
      if (mode === 'agent' && res.agentRun) {
        onRun(res.agentRun.id);
        setBanner(
          `System Architect (${res.agentRun.agent}) is inspecting ${proj?.name ?? 'the repository'} to generate a tailored milestone roadmap…`,
        );
      } else {
        setBanner(
          'Auto-generated project-tailored milestones & tasks from PROJECT.md and repository context!',
        );
      }
    });
  };

  const handleSmartQuickAdd = (e: FormEvent) => {
    e.preventDefault();
    const raw = quickAddText.trim();
    if (!raw) return;
    return task('quick-add', async () => {
      if (quickAddTarget === '__new_milestone__') {
        setRm(await api<ProjectRoadmapState>(`${base}/milestones`, 'POST', { title: raw }));
        setQuickAddText('');
        setQuickAddTarget('auto');
        setBanner(`Created new milestone "${raw}".`);
      } else {
        setRm(
          await api<ProjectRoadmapState>(`${base}/items`, 'POST', {
            milestoneId: quickAddTarget || 'auto',
            title: raw,
          }),
        );
        setQuickAddText('');
        setBanner(`Auto-routed "${raw}" to the right milestone, specialist persona & AI model!`);
      }
    });
  };

  const handleDispatchSelected = (autoStart: boolean) => {
    if (totalSelected === 0) return;
    return task(autoStart ? 'dispatch-run' : 'dispatch-board', async () => {
      const res = await api<DispatchRoadmapItemsResponse>(`${base}/dispatch`, 'POST', {
        itemIds,
        suggestionIds: sugIds,
        autoStart,
      });
      setRm(res.roadmap);
      clear();
      setBanner(
        `Created ${res.createdTickets.length} Kanban ticket(s)${res.startedRun ? ` and launched agent run (${res.startedRun.title ?? res.startedRun.id.slice(0, 8)})` : ''}!`,
      );
    });
  };

  return (
    <section className="panel" style={{ padding: '14px 16px' }}>
      <div style={RM_HEAD_SPLIT}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
              {ico(Target)} {proj?.name ?? 'Project'} — Roadmap, Milestones &amp; AI Brainstorming Studio
            </h2>
            <span className="badge mono">
              {roadmap.completedItems}/{roadmap.totalItems} completed ({roadmap.completionPercent}%)
            </span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: '0.82rem', maxWidth: 820 }}>
            {roadmap.visionSummary}
          </p>
        </div>

        <div className="actions" style={RM_ROW_WRAP8}>
          <button
            id="roadmap-autogen-instant-btn"
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={() => void handleAutoGenerateRoadmap('instant')}
            title="Automatically synthesize domain-tailored milestones & roadmap tasks from PROJECT.md and codebase"
          >
            {busy === 'autogen-instant' ? 'Generating…' : <>{ico(Sparkles)} Auto-Generate Roadmap</>}
          </button>
          <button
            id="roadmap-autogen-agent-btn"
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy !== null || working}
            onClick={() => void handleAutoGenerateRoadmap('agent')}
            title="Dispatch the System Architect agent to inspect the repository and generate a full custom milestone roadmap"
          >
            {busy === 'autogen-agent' ? (
              'Launching…'
            ) : working ? (
              <>{ico(Landmark)} Architect Working…</>
            ) : (
              <>{ico(Bot)} AI Architect Roadmap</>
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => navigate(`/projects/${pid}/board`)}
          >
            {ico(SquareKanban)} Open Kanban Board
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
        <div style={RM_ROW_WRAP8}>
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
        onSubmit={(e) => void handleSmartQuickAdd(e)}
        style={{
          marginTop: 12,
          ...RM_ROW_WRAP8,
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
          onChange={(e) => setQuickAddTarget(e.target.value)}
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
          onChange={(e) => setQuickAddText(e.target.value)}
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
            ...RM_ROW_BETWEEN,
            gap: 10,
          }}
        >
          <span className="mono" style={{ fontSize: '0.82rem', fontWeight: 600 }}>
            {ico(SquareCheck)} {totalSelected} selected ({sugIds.length} suggestion
            {sugIds.length === 1 ? '' : 's'}, {itemIds.length} roadmap item
            {itemIds.length === 1 ? '' : 's'})
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>
              Clear Selection
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void handleDispatchSelected(false)}
            >
              {ico(Inbox)} Create Ready Tickets on Board
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null}
              onClick={() => void handleDispatchSelected(true)}
            >
              {busy === 'dispatch-run' ? (
                'Dispatching…'
              ) : (
                <>{ico(Rocket)} Create Tickets &amp; Auto-Dispatch Multi-Agent Pipeline</>
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
      {err && (
        <div className="banner banner-error" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
    </section>
  );
}
