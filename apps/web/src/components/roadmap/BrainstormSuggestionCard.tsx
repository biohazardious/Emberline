import type { AgentId, AgentModelId, BrainstormSuggestion, Run } from '@emberline/protocol';
import { Bot, Brain, Rocket, Zap } from 'lucide-react';
import { Link } from 'wouter';
import { PersonaBadge } from '../PersonaBadge';
import { ico } from '../SectionState';
import { CATEGORY_META, RM_BADGE_68, RM_ROW_BETWEEN, RM_ROW_WRAP6, RouteBadgeSelect } from './roadmapMeta';

export function BrainstormSuggestionCard({
  sug,
  checked,
  provs,
  busy,
  onToggle,
  onDismiss,
  onRoute,
  onPromote,
}: {
  sug: BrainstormSuggestion;
  checked: boolean;
  provs: AgentId[];
  busy: string | null;
  onToggle: () => void;
  onDismiss: () => void;
  onRoute: (agent: AgentId, model: AgentModelId) => void;
  onPromote: (autoStart: boolean) => void;
}) {
  const cat = CATEGORY_META[sug.category] ?? CATEGORY_META.feature;
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 'var(--radius)',
        background: checked ? 'color-mix(in srgb, var(--ember-1) 8%, transparent)' : 'var(--bg-elevated)',
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
          <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 3 }} />
          <span>
            {cat.icon} {sug.title}
          </span>
        </label>
        <button type="button" className="icon-btn" title="Dismiss suggestion" onClick={onDismiss}>
          ×
        </button>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.45 }}>
        {sug.rationale}
      </p>

      <div style={{ ...RM_ROW_BETWEEN, paddingTop: 4 }}>
        <div style={RM_ROW_WRAP6}>
          <span className="badge mono" style={RM_BADGE_68}>
            Target: {sug.suggestedMilestoneCode}
          </span>
          <PersonaBadge persona={sug.persona} />
          <RouteBadgeSelect
            agent={sug.preferredAgent}
            model={sug.preferredModel}
            persona={sug.persona}
            enabledProviders={provs}
            disabled={busy !== null}
            onChange={onRoute}
          />
          <span className="badge mono" style={RM_BADGE_68}>
            Impact: {sug.impact.toUpperCase()}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy !== null}
            onClick={() => onPromote(false)}
            title={`Add to Milestone ${sug.suggestedMilestoneCode} without starting a run yet`}
          >
            + Add to {sug.suggestedMilestoneCode}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy !== null}
            onClick={() => onPromote(true)}
            title="Add to Roadmap, create Kanban ticket, and start the specialist agent immediately"
          >
            {busy === `sug-${sug.id}` ? 'Starting…' : <>{ico(Rocket)} Build Now</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BrainstormingEmptyState({ name, working }: { name: string | undefined; working: boolean }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '24px 16px',
        borderRadius: 'var(--radius)',
        border: '1px dashed var(--border)',
        background: 'var(--bg)',
      }}
    >
      {working ? (
        <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
          {ico(Brain)} <strong>Deep Brainstorming Agent</strong> is analyzing{' '}
          <strong>{name ?? 'this project'}</strong>… Tailored suggestions will automatically appear here as
          soon as analysis finishes.
        </p>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
          Brainstorming list is empty. Click <strong>{ico(Bot)} Deep Agent Brainstorm</strong> (for full AI
          codebase analysis) or <strong>{ico(Zap)} Synthesize Ideas</strong> above to populate suggestions
          tailored to <strong>{name ?? 'this project'}</strong>.
        </p>
      )}
    </div>
  );
}

export function ActiveBrainstormRunBanner({ run }: { run: Run }) {
  return (
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
        Deep Brainstorming Agent ({run.agent} · fable) is inspecting the repository…
      </span>
      {run.terminalId && (
        <Link
          href={`/terminals/${run.terminalId}`}
          className="btn btn-sm btn-ghost mono"
          style={{ fontSize: '0.72rem', padding: '2px 8px' }}
        >
          View Terminal →
        </Link>
      )}
    </div>
  );
}
