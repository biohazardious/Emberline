import type { AgentPersona, TaskTemplate } from '@emberline/protocol';
import { api } from '../api';
import { usePoll } from '../hooks/usePoll';

export interface PersonaMeta {
  id: AgentPersona;
  label: string;
  shortLabel: string;
  hint: string;
}

export const PERSONA_LIST: readonly PersonaMeta[] = [
  {
    id: 'coder',
    label: 'Coder',
    shortLabel: 'DEV',
    hint: 'Full-Stack Software Engineer — implements features and fixes bugs with tests',
  },
  {
    id: 'product_owner',
    label: 'Product Owner',
    shortLabel: 'PO',
    hint: 'Product Owner — refines PROJECT.md, user stories, and acceptance criteria',
  },
  {
    id: 'architect',
    label: 'Architect',
    shortLabel: 'ARCH',
    hint: 'System Architect — designs module boundaries, contracts, and repo structure',
  },
  {
    id: 'ui_ux',
    label: 'UI/UX',
    shortLabel: 'UI/UX',
    hint: 'UI/UX Engineer — polishes layout, design system, accessibility, and interactions',
  },
  {
    id: 'dba',
    label: 'DBA',
    shortLabel: 'DBA',
    hint: 'Database Architect — designs schemas, migrations, indexes, and queries',
  },
  {
    id: 'qa',
    label: 'QA',
    shortLabel: 'QA',
    hint: 'QA & Test Engineer — writes unit/integration/E2E tests and verifies edge cases',
  },
  {
    id: 'security',
    label: 'Security',
    shortLabel: 'SEC',
    hint: 'Security Engineer — audits auth, input validation, permissions, and secrets',
  },
];

export const PERSONA_BY_ID: Record<AgentPersona, PersonaMeta> = Object.fromEntries(
  PERSONA_LIST.map((p) => [p.id, p]),
) as Record<AgentPersona, PersonaMeta>;

export function PersonaBadge({
  persona,
  showFull = false,
}: {
  persona: AgentPersona | undefined;
  showFull?: boolean;
}) {
  const id = persona ?? 'coder';
  const meta = PERSONA_BY_ID[id] ?? PERSONA_BY_ID.coder;
  return (
    <span
      className={`badge persona-badge persona-${meta.id} mono`}
      title={meta.hint}
    >
      {showFull ? meta.label : meta.shortLabel}
    </span>
  );
}

export function PersonaPicker({
  value,
  onChange,
  compact = false,
}: {
  value: AgentPersona;
  onChange: (persona: AgentPersona) => void;
  compact?: boolean;
}) {
  return (
    <div className="segmented segmented-wrap" role="radiogroup" aria-label="Agent Persona">
      {PERSONA_LIST.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          className={value === p.id ? 'active' : ''}
          title={p.hint}
          onClick={() => onChange(p.id)}
        >
          {compact ? p.shortLabel : p.label}
        </button>
      ))}
    </div>
  );
}

export function TaskTemplateBar({
  onSelect,
}: {
  onSelect: (template: TaskTemplate) => void;
}) {
  const templates = usePoll(() => api<TaskTemplate[]>('/api/factory/templates'), 60_000);
  const list = templates.data ?? [];
  if (list.length === 0) return null;

  return (
    <div className="template-bar" aria-label="Ready-made task templates">
      <span className="template-label mono">Templates:</span>
      {list.map((tpl) => {
        const personaMeta = PERSONA_BY_ID[tpl.persona] ?? PERSONA_BY_ID.coder;
        return (
          <button
            key={tpl.id}
            type="button"
            className="chip-btn"
            title={`[${personaMeta.label}] ${tpl.titlePlaceholder}`}
            onClick={() => onSelect(tpl)}
          >
            <span className="mono muted" style={{ marginRight: '4px' }}>
              [{personaMeta.shortLabel}]
            </span>
            {tpl.label}
          </button>
        );
      })}
    </div>
  );
}
