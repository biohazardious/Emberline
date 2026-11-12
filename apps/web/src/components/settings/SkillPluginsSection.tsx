import type { AgentPersona, SkillPluginCategory, SkillPluginEntry } from '@emberline/protocol';
import { Plus, Puzzle, X } from 'lucide-react';
import { useState } from 'react';
import { PERSONA_LIST } from '../PersonaBadge';
import { ico } from '../SectionState';
import {
  ST_BADGE_64,
  ST_CARD_GRID_310,
  ST_COL_6,
  ST_COL_14,
  ST_CUSTOM_BOX,
  ST_DESC_73,
  ST_FIELD_4,
  ST_HEAD_SPLIT,
  ST_LABEL_68,
  ST_ROW_BETWEEN,
  ST_ROW_WRAP6,
  ST_SAVE_ROW,
} from './settingsMeta';

export function PersonaScopePills({
  labelPrefix,
  personas,
  onSelectAll,
  onToggle,
  itemTitle,
}: {
  labelPrefix: string;
  personas: AgentPersona[];
  onSelectAll: () => void;
  onToggle: (persona: AgentPersona) => void;
  itemTitle?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span className="muted mono" style={{ fontSize: '0.65rem' }}>
        {labelPrefix} ({personas.length === 0 ? 'All Personas' : `${personas.length} Selected`})
      </span>
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onSelectAll}
          className="mono"
          style={{
            fontSize: '0.64rem',
            padding: '2px 6px',
            borderRadius: '4px',
            cursor: 'pointer',
            background:
              personas.length === 0 ? 'color-mix(in srgb, var(--info) 20%, transparent)' : 'transparent',
            border:
              personas.length === 0
                ? '1px solid color-mix(in srgb, var(--info) 50%, transparent)'
                : '1px solid var(--border)',
            color: personas.length === 0 ? 'var(--info)' : 'var(--text-muted)',
          }}
        >
          ALL
        </button>
        {PERSONA_LIST.map((p) => {
          const active = personas.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onToggle(p.id)}
              className="mono"
              style={{
                fontSize: '0.64rem',
                padding: '2px 6px',
                borderRadius: '4px',
                cursor: 'pointer',
                background: active ? 'color-mix(in srgb, var(--ok) 18%, transparent)' : 'transparent',
                border: active
                  ? '1px solid color-mix(in srgb, var(--ok) 50%, transparent)'
                  : '1px solid var(--border)',
                color: active ? 'var(--ok)' : 'var(--text-muted)',
              }}
              title={itemTitle ? `Toggle ${p.label} access to ${itemTitle}` : undefined}
            >
              {p.shortLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SkillPluginsSection({
  skills,
  onChangeSkillPlugins,
}: {
  skills: SkillPluginEntry[];
  onChangeSkillPlugins: (next: SkillPluginEntry[]) => void;
}) {
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [skillName, setSkillName] = useState('');
  const [skillDesc, setSkillDesc] = useState('');
  const [skillCategory, setSkillCategory] = useState<SkillPluginCategory>('custom');
  const [skillInstructions, setSkillInstructions] = useState('');

  const toggleSkillEnabled = (id: string) => {
    onChangeSkillPlugins(skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)));
  };

  const toggleSkillPersona = (id: string, persona: AgentPersona) => {
    onChangeSkillPlugins(
      skills.map((sk) => {
        if (sk.id !== id) return sk;
        const exists = sk.personas.includes(persona);
        const nextPersonas = exists ? sk.personas.filter((p) => p !== persona) : [...sk.personas, persona];
        return { ...sk, personas: nextPersonas };
      }),
    );
  };

  const setSkillAllPersonas = (id: string) => {
    onChangeSkillPlugins(skills.map((sk) => (sk.id === id ? { ...sk, personas: [] } : sk)));
  };

  const removeCustomSkill = (id: string) => {
    onChangeSkillPlugins(skills.filter((sk) => sk.id !== id));
  };

  const handleCreateCustomSkill = () => {
    const cleanName = skillName.trim();
    const cleanInst = skillInstructions.trim();
    if (!cleanName || !cleanInst) return;
    const slug =
      cleanName
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `skill-${Date.now()}`;

    const entry: SkillPluginEntry = {
      id: slug,
      name: cleanName,
      description: skillDesc.trim() || 'Custom engineering skill & prompt rule plugin.',
      icon: '🧩',
      category: skillCategory,
      instructions: cleanInst,
      enabled: true,
      builtIn: false,
      personas: [],
    };

    onChangeSkillPlugins([...skills.filter((s) => s.id !== slug), entry]);
    setSkillName('');
    setSkillDesc('');
    setSkillInstructions('');
    setShowAddSkill(false);
  };

  const activeSkillCount = skills.filter((s) => s.enabled).length;

  return (
    <div style={ST_COL_14}>
      <div style={ST_HEAD_SPLIT}>
        <div>
          <span className="eyebrow">Reusable Agent Skills &amp; Craftsmanship Rules</span>
          <h3 style={{ margin: '4px 0 4px' }}>
            {ico(Puzzle)} Skill &amp; Rule Plugins ({activeSkillCount} of {skills.length} Active)
          </h3>
          <p className="muted small" style={{ maxWidth: 740, margin: 0 }}>
            Modular domain skills and coding standards injected into matching specialist personas on launch.
            Built-in skills come enabled out of the box; you can also author custom team rules below.
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setShowAddSkill((v) => !v)}>
          {showAddSkill ? 'Cancel' : <>{ico(Plus)} Add Custom Skill Plugin</>}
        </button>
      </div>

      {showAddSkill && (
        <div style={ST_CUSTOM_BOX}>
          <strong style={{ fontSize: '0.85rem' }}>Create Custom Skill / Rule Plugin</strong>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
              gap: '10px',
            }}
          >
            <label className="field" style={ST_FIELD_4}>
              <span className="muted mono" style={ST_LABEL_68}>
                Skill Name
              </span>
              <input
                type="text"
                className="input"
                placeholder="e.g. Hexagonal Domain Architecture"
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
              />
            </label>
            <label className="field" style={ST_FIELD_4}>
              <span className="muted mono" style={ST_LABEL_68}>
                Category
              </span>
              <select
                className="input"
                value={skillCategory}
                onChange={(e) => setSkillCategory(e.target.value as SkillPluginCategory)}
              >
                <option value="custom">Custom Rule</option>
                <option value="ui_ux">UI/UX &amp; Design</option>
                <option value="architecture">Architecture &amp; Types</option>
                <option value="security">Security</option>
                <option value="qa">QA &amp; Testing</option>
                <option value="workflow">Workflow</option>
              </select>
            </label>
            <label className="field" style={ST_FIELD_4}>
              <span className="muted mono" style={ST_LABEL_68}>
                Short Description
              </span>
              <input
                type="text"
                className="input"
                placeholder="Summary shown on the plugin card"
                value={skillDesc}
                onChange={(e) => setSkillDesc(e.target.value)}
              />
            </label>
          </div>

          <label className="field" style={ST_FIELD_4}>
            <span className="muted mono" style={ST_LABEL_68}>
              Skill Instructions (Injected into Agent System Prompt)
            </span>
            <textarea
              className="input mono"
              rows={3}
              placeholder="Write explicit engineering or UI/UX rules for agents to follow…"
              value={skillInstructions}
              onChange={(e) => setSkillInstructions(e.target.value)}
            />
          </label>

          <div style={ST_SAVE_ROW}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={handleCreateCustomSkill}
              disabled={!skillName.trim() || !skillInstructions.trim()}
            >
              Add Skill Plugin
            </button>
          </div>
        </div>
      )}

      {skills.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          No skill plugins configured yet.
        </p>
      ) : (
        <div style={ST_CARD_GRID_310}>
          {skills.map((sk) => (
            <div
              key={sk.id}
              style={{
                padding: '13px',
                borderRadius: '8px',
                background: sk.enabled
                  ? 'var(--surface-2)'
                  : 'color-mix(in srgb, var(--text) 1.5%, transparent)',
                border: sk.enabled
                  ? '1px solid color-mix(in srgb, var(--ok) 45%, transparent)'
                  : '1px dashed var(--border)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div style={ST_COL_6}>
                <div style={ST_ROW_BETWEEN}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                    <span style={{ fontSize: '1.05rem' }}>{sk.icon}</span>
                    <strong style={{ fontSize: '0.88rem' }}>{sk.name}</strong>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <button
                      type="button"
                      className={`btn btn-xs ${sk.enabled ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => toggleSkillEnabled(sk.id)}
                    >
                      {sk.enabled ? '✓ Active' : '+ Enable'}
                    </button>
                    {!sk.builtIn && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={() => removeCustomSkill(sk.id)}
                        title="Remove custom skill plugin"
                        aria-label="Remove custom skill plugin"
                      >
                        {ico(X)}
                      </button>
                    )}
                  </div>
                </div>

                <div style={ST_ROW_WRAP6}>
                  <span className="badge mono" style={ST_BADGE_64}>
                    {sk.category.toUpperCase()}
                  </span>
                  <span className="badge mono" style={ST_BADGE_64}>
                    {sk.builtIn ? 'Built-In Skill' : 'Custom Skill'}
                  </span>
                </div>

                <div className="muted small" style={ST_DESC_73}>
                  {sk.description}
                </div>
              </div>

              <PersonaScopePills
                labelPrefix="Target Personas"
                personas={sk.personas}
                onSelectAll={() => setSkillAllPersonas(sk.id)}
                onToggle={(persona) => toggleSkillPersona(sk.id, persona)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
