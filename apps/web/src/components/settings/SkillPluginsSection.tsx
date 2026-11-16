import type { AgentPersona, SkillPluginCategory, SkillPluginEntry } from '@emberline/protocol';
import { useState } from 'react';
import { HelpHint } from '../ui/HelpHint';
import { PersonaScopePills, SkillPluginRow } from './automation/SkillPluginRow';
import './settings-sections.css';

export { PersonaScopePills };

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

  const updateSkill = (id: string, patch: Partial<SkillPluginEntry>) => {
    onChangeSkillPlugins(skills.map((sk) => (sk.id === id ? { ...sk, ...patch } : sk)));
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
      description: skillDesc.trim() || 'Custom skill plugin.',
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
    <section className="settings-group" aria-labelledby="skills-heading">
      <header className="settings-group-head settings-group-head-split">
        <div className="settings-group-title-row">
          <h2 id="skills-heading">Skills</h2>
          <span className="badge mono">
            {activeSkillCount} of {skills.length} on
          </span>
          <HelpHint topic="skills">
            Enabled domain skills and coding rules are injected into matching specialist personas on launch.
          </HelpHint>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={showAddSkill}
          onClick={() => setShowAddSkill((v) => !v)}
        >
          {showAddSkill ? 'Cancel' : 'Add skill'}
        </button>
      </header>

      {showAddSkill && (
        <div className="settings-add-box">
          <div className="settings-field-grid">
            <label className="field">
              <span>Skill name</span>
              <input
                type="text"
                className="input"
                placeholder="Hexagonal domain architecture"
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Category</span>
              <select
                className="input"
                value={skillCategory}
                onChange={(e) => setSkillCategory(e.target.value as SkillPluginCategory)}
              >
                <option value="custom">Custom</option>
                <option value="ui_ux">UI and design</option>
                <option value="architecture">Architecture and types</option>
                <option value="security">Security</option>
                <option value="qa">QA and testing</option>
                <option value="workflow">Workflow</option>
              </select>
            </label>
            <label className="field">
              <span>Description</span>
              <input
                type="text"
                className="input"
                placeholder="One-line summary"
                value={skillDesc}
                onChange={(e) => setSkillDesc(e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>Rule text</span>
            <textarea
              className="input mono"
              rows={3}
              placeholder="Write engineering or design rules for agents to follow…"
              value={skillInstructions}
              onChange={(e) => setSkillInstructions(e.target.value)}
            />
          </label>

          <div className="settings-form-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleCreateCustomSkill}
              disabled={!skillName.trim() || !skillInstructions.trim()}
            >
              Add skill
            </button>
          </div>
        </div>
      )}

      {skills.length === 0 ? (
        <p className="muted small">No skill plugins configured yet.</p>
      ) : (
        <div className="settings-group-rows">
          {skills.map((sk) => (
            <SkillPluginRow
              key={sk.id}
              skill={sk}
              onToggleEnabled={toggleSkillEnabled}
              onTogglePersona={toggleSkillPersona}
              onSelectAllPersonas={setSkillAllPersonas}
              onUpdate={updateSkill}
              onRemove={removeCustomSkill}
            />
          ))}
        </div>
      )}
    </section>
  );
}
