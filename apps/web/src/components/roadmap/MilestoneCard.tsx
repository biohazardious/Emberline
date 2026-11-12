import type {
  DispatchRoadmapItemsResponse,
  ProjectRoadmapState,
  RoadmapItem,
  RoadmapMilestone,
} from '@emberline/protocol';
import { Rocket, Sparkles, SquareKanban } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../api';
import { PersonaBadge } from '../PersonaBadge';
import { ico } from '../SectionState';
import {
  RM_CARD_ELEV,
  RM_ROW_BETWEEN,
  RM_ROW_WRAP6,
  ROADMAP_STATUS_LABEL,
  ROADMAP_STATUS_MARK,
  type RoadmapStudioCtx,
  RouteBadgeSelect,
} from './roadmapMeta';

export function MilestoneCard({
  ctx,
  ms,
  items,
  canDel,
  sel,
  toggle,
}: {
  ctx: RoadmapStudioCtx;
  ms: RoadmapMilestone;
  items: RoadmapItem[];
  canDel: boolean;
  sel: Set<string>;
  toggle: (id: string) => void;
}) {
  const { pid, base, provs, busy, setRm, setBanner, route, task } = ctx;
  const [inlineInput, setInlineInput] = useState('');
  const doneCount = ms.items.filter((i) => i.status === 'done').length;
  const pct = ms.items.length > 0 ? Math.round((doneCount / ms.items.length) * 100) : 0;
  const undispatchedIds = ms.items.filter((i) => i.status !== 'done').map((i) => i.id);

  const toggleDone = (item: RoadmapItem) =>
    task(
      null,
      async () => {
        setRm(
          await api<ProjectRoadmapState>(`${base}/items/${item.id}`, 'PATCH', {
            status: item.status === 'done' ? 'planned' : 'done',
          }),
        );
      },
      false,
    );

  const deleteItem = (itemId: string) =>
    task(
      null,
      async () => {
        setRm(await api<ProjectRoadmapState>(`${base}/items/${itemId}`, 'DELETE'));
      },
      false,
    );

  const dispatchItem = (itemId: string) =>
    task(
      `item-${itemId}`,
      async () => {
        const res = await api<DispatchRoadmapItemsResponse>(`${base}/dispatch`, 'POST', {
          itemIds: [itemId],
          autoStart: true,
        });
        setRm(res.roadmap);
        setBanner(
          `Dispatched item to Kanban Board (${res.createdTickets[0]?.key ?? 'ready'}) and started autonomous execution!`,
        );
      },
      false,
    );

  const dispatchMilestone = () =>
    task(
      `ms-${ms.id}`,
      async () => {
        const res = await api<DispatchRoadmapItemsResponse>(`${base}/dispatch`, 'POST', {
          itemIds: undispatchedIds,
          autoStart: true,
        });
        setRm(res.roadmap);
        setBanner(
          `Dispatched Milestone ${ms.code} (${res.createdTickets.length} new ticket(s)) to the AI Coding Factory!`,
        );
      },
      false,
    );

  const deleteMilestone = () =>
    task(
      `del-ms-${ms.id}`,
      async () => {
        setRm(await api<ProjectRoadmapState>(`${base}/milestones/${ms.id}`, 'DELETE'));
        setBanner(`Removed milestone ${ms.code} (any remaining items were preserved).`);
      },
      false,
    );

  const submitInline = () => {
    const raw = inlineInput.trim();
    if (!raw) return;
    return task(
      `inline-add-${ms.id}`,
      async () => {
        setRm(
          await api<ProjectRoadmapState>(`${base}/items`, 'POST', {
            milestoneId: ms.id,
            title: raw,
          }),
        );
        setInlineInput('');
        setBanner(`Added "${raw}" to ${ms.code} (auto-assigned specialist & model).`);
      },
      false,
    );
  };

  return (
    <div style={RM_CARD_ELEV}>
      <div style={RM_ROW_BETWEEN}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge mono" style={{ fontWeight: 700 }}>
              {ms.code}
            </span>
            <strong style={{ fontSize: '0.92rem' }}>{ms.title}</strong>
            <span className="muted mono" style={{ fontSize: '0.75rem' }}>
              {doneCount}/{ms.items.length} ({pct}%)
            </span>
          </div>
          {ms.description && (
            <p className="muted" style={{ margin: '3px 0 0', fontSize: '0.76rem' }}>
              {ms.description}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {undispatchedIds.length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void dispatchMilestone()}
              title={`Create Kanban tickets for all remaining items in ${ms.code} and start execution`}
            >
              {busy === `ms-${ms.id}` ? (
                'Starting…'
              ) : (
                <>
                  {ico(Rocket)} Run {ms.code}
                </>
              )}
            </button>
          )}
          {canDel && (
            <button
              type="button"
              className="icon-btn"
              disabled={busy !== null}
              onClick={() => void deleteMilestone()}
              title={`Remove milestone ${ms.code}`}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          width: '100%',
          height: 5,
          borderRadius: 999,
          background: 'var(--bg)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: pct === 100 ? 'var(--ok)' : 'var(--accent)',
          }}
        />
      </div>

      {ms.items.length > 0 && items.length === 0 ? (
        <p className="muted small" style={{ margin: '2px 0' }}>
          No items in {ms.code} match the filter.
        </p>
      ) : ms.items.length === 0 ? (
        <p className="muted small" style={{ margin: '2px 0' }}>
          No items in {ms.code} yet. Click <strong>{ico(Sparkles)} Auto-Generate Roadmap</strong> above,
          promote a brainstorm idea, or type below.
        </p>
      ) : (
        <ul className="list" style={{ margin: 0 }}>
          {items.map((item) => {
            const isDone = item.status === 'done';
            const isChecked = sel.has(item.id);
            return (
              <li
                key={item.id}
                className="row"
                style={{ padding: '8px 10px', opacity: isDone ? 0.72 : 1, ...RM_ROW_BETWEEN }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 200 }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(item.id)}
                    title="Select for batch dispatch"
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost mono"
                    style={{ padding: '2px 6px', fontSize: '0.72rem' }}
                    onClick={() => void toggleDone(item)}
                    title={isDone ? 'Mark as planned' : 'Mark as done'}
                  >
                    {ROADMAP_STATUS_MARK[item.status]} {ROADMAP_STATUS_LABEL[item.status].toUpperCase()}
                  </button>
                  <span
                    style={{
                      fontSize: '0.84rem',
                      fontWeight: 500,
                      textDecoration: isDone ? 'line-through' : 'none',
                    }}
                  >
                    {item.title}
                  </span>
                </div>

                <div style={RM_ROW_WRAP6}>
                  <PersonaBadge persona={item.persona} />
                  <RouteBadgeSelect
                    agent={item.preferredAgent}
                    model={item.preferredModel}
                    persona={item.persona}
                    enabledProviders={provs}
                    disabled={busy !== null}
                    onChange={(nextAgent, nextModel) => route(item.id, nextAgent, nextModel)}
                  />
                  {item.ticketKey ? (
                    <Link
                      href={`/projects/${pid}/board`}
                      className="badge mono"
                      style={{ fontSize: '0.7rem', textDecoration: 'none' }}
                      title="View linked ticket on Kanban Board"
                    >
                      {ico(SquareKanban)} {item.ticketKey}
                    </Link>
                  ) : (
                    !isDone && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                        disabled={busy !== null}
                        onClick={() => void dispatchItem(item.id)}
                        title="Create Kanban ticket and start specialist agent"
                      >
                        {busy === `item-${item.id}` ? '…' : <>{ico(Rocket)} Dispatch</>}
                      </button>
                    )
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    title="Remove from roadmap"
                    onClick={() => void deleteItem(item.id)}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
        <input
          className="input"
          style={{ flex: 1, fontSize: '0.78rem', padding: '5px 8px' }}
          placeholder={`+ Add task to ${ms.code} and press Enter (auto-routes persona & model)…`}
          value={inlineInput}
          onChange={(e) => setInlineInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submitInline();
            }
          }}
        />
        {inlineInput.trim() && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ padding: '4px 10px', fontSize: '0.74rem' }}
            disabled={busy !== null}
            onClick={() => void submitInline()}
          >
            Add
          </button>
        )}
      </div>
    </div>
  );
}
