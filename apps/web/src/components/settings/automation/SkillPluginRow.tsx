import type { AgentPersona, SkillPluginEntry } from '@emberline/protocol';
import { PERSONA_LIST } from '../../PersonaBadge';
import { SettingRow } from '../../ui/SettingRow';
import { Switch } from '../../ui/Switch';

export function PersonaScopePills({
  labelPrefix = 'Personas',
  personas,
  onSelectAll,
  onToggle,
  itemTitle,
}: {
  labelPrefix?: string;
  personas: AgentPersona[];
  onSelectAll: () => void;
  onToggle: (persona: AgentPersona) => void;
  itemTitle?: string;
}) {
  const scopeSummary = personas.length === 0 ? 'All personas' : `${personas.length} selected`;

  return (
    <div className="settings-persona-scope">
      <div className="settings-persona-head">
        <strong>{labelPrefix}</strong>
        <span className="muted mono">{scopeSummary}</span>
      </div>
      <div className="settings-persona-pills">
        <button
          type="button"
          onClick={onSelectAll}
          aria-pressed={personas.length === 0}
          className={`settings-persona-pill${personas.length === 0 ? ' settings-persona-pill-all' : ''}`}
        >
          All
        </button>
        {PERSONA_LIST.map((p) => {
          const active = personas.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onToggle(p.id)}
              aria-pressed={active}
              aria-label={itemTitle ? `${p.label} access for ${itemTitle}` : p.label}
              className={`settings-persona-pill${active ? ' settings-persona-pill-active' : ''}`}
            >
              {p.shortLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SkillPluginRow({
  skill,
  onToggleEnabled,
  onTogglePersona,
  onSelectAllPersonas,
  onUpdate,
  onRemove,
}: {
  skill: SkillPluginEntry;
  onToggleEnabled: (id: string) => void;
  onTogglePersona: (id: string, persona: AgentPersona) => void;
  onSelectAllPersonas: (id: string) => void;
  onUpdate: (id: string, patch: Partial<SkillPluginEntry>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <SettingRow
      label={skill.name}
      summary={skill.description}
      control={
        <>
          {!skill.builtIn && (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              aria-label={`Remove ${skill.name}`}
              onClick={() => onRemove(skill.id)}
            >
              Remove
            </button>
          )}
          <Switch
            checked={skill.enabled}
            onChange={() => onToggleEnabled(skill.id)}
            ariaLabel={`Enable ${skill.name}`}
          />
        </>
      }
      details={
        <div className="settings-detail-stack">
          <div className="settings-detail-meta">
            <span className="badge mono">{skill.category.toUpperCase()}</span>
            <span className="badge mono">{skill.builtIn ? 'Built-in' : 'Custom'}</span>
          </div>

          <label className="field">
            <span>Rule text</span>
            <textarea
              className="input mono"
              rows={3}
              aria-label={`Rule text for ${skill.name}`}
              value={skill.instructions}
              onChange={(e) => onUpdate(skill.id, { instructions: e.target.value })}
            />
          </label>

          <PersonaScopePills
            personas={skill.personas}
            onSelectAll={() => onSelectAllPersonas(skill.id)}
            onToggle={(persona) => onTogglePersona(skill.id, persona)}
            itemTitle={skill.name}
          />
        </div>
      }
    />
  );
}
