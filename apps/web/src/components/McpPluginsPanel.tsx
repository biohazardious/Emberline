import {
  type AgentPersona,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  type McpServerEntry,
  type McpServerTransport,
  type SkillPluginCategory,
  type SkillPluginEntry,
} from '@emberline/protocol';
import { Plug, Plus, Puzzle, Save, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { PERSONA_LIST } from './PersonaBadge';

interface Props {
  mcpServers: McpServerEntry[];
  skillPlugins: SkillPluginEntry[];
  saving: boolean;
  onChangeMcpServers: (next: McpServerEntry[]) => void;
  onChangeSkillPlugins: (next: SkillPluginEntry[]) => void;
  onSave: (e: FormEvent) => void;
}

export function McpPluginsPanel({
  mcpServers,
  skillPlugins,
  saving,
  onChangeMcpServers,
  onChangeSkillPlugins,
  onSave,
}: Props) {
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [mcpId, setMcpId] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpDesc, setMcpDesc] = useState('');
  const [mcpTransport, setMcpTransport] = useState<McpServerTransport>('stdio');
  const [mcpCommand, setMcpCommand] = useState('npx');
  const [mcpArgs, setMcpArgs] = useState('-y @modelcontextprotocol/server-everything');
  const [mcpUrl, setMcpUrl] = useState('');

  const [showAddSkill, setShowAddSkill] = useState(false);
  const [skillName, setSkillName] = useState('');
  const [skillDesc, setSkillDesc] = useState('');
  const [skillCategory, setSkillCategory] = useState<SkillPluginCategory>('custom');
  const [skillInstructions, setSkillInstructions] = useState('');

  const servers = mcpServers.length > 0 ? mcpServers : DEFAULT_MCP_SERVERS;
  const skills = skillPlugins.length > 0 ? skillPlugins : DEFAULT_SKILL_PLUGINS;

  const toggleMcpEnabled = (id: string) => {
    onChangeMcpServers(
      servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
  };

  const toggleMcpPersona = (id: string, persona: AgentPersona) => {
    onChangeMcpServers(
      servers.map((s) => {
        if (s.id !== id) return s;
        const exists = s.personas.includes(persona);
        const nextPersonas = exists
          ? s.personas.filter((p) => p !== persona)
          : [...s.personas, persona];
        return { ...s, personas: nextPersonas };
      }),
    );
  };

  const setMcpAllPersonas = (id: string) => {
    onChangeMcpServers(
      servers.map((s) => (s.id === id ? { ...s, personas: [] } : s)),
    );
  };

  const removeCustomMcp = (id: string) => {
    onChangeMcpServers(servers.filter((s) => s.id !== id));
  };

  const handleCreateCustomMcp = () => {
    const cleanName = mcpName.trim();
    if (!cleanName) return;
    const slug =
      (mcpId.trim() || cleanName)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `custom-mcp-${Date.now()}`;

    const entry: McpServerEntry = {
      id: slug,
      name: cleanName,
      description: mcpDesc.trim() || 'Custom user-configured MCP tool server.',
      icon: '🔌',
      transport: mcpTransport,
      command: mcpTransport === 'stdio' ? mcpCommand.trim() : '',
      args:
        mcpTransport === 'stdio'
          ? mcpArgs
              .trim()
              .split(/\s+/)
              .filter(Boolean)
          : [],
      url: mcpTransport !== 'stdio' ? mcpUrl.trim() || null : null,
      env: {},
      enabled: true,
      builtIn: false,
      personas: [],
    };

    onChangeMcpServers([...servers.filter((s) => s.id !== slug), entry]);
    setMcpId('');
    setMcpName('');
    setMcpDesc('');
    setShowAddMcp(false);
  };

  const toggleSkillEnabled = (id: string) => {
    onChangeSkillPlugins(
      skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)),
    );
  };

  const toggleSkillPersona = (id: string, persona: AgentPersona) => {
    onChangeSkillPlugins(
      skills.map((sk) => {
        if (sk.id !== id) return sk;
        const exists = sk.personas.includes(persona);
        const nextPersonas = exists
          ? sk.personas.filter((p) => p !== persona)
          : [...sk.personas, persona];
        return { ...sk, personas: nextPersonas };
      }),
    );
  };

  const setSkillAllPersonas = (id: string) => {
    onChangeSkillPlugins(
      skills.map((sk) => (sk.id === id ? { ...sk, personas: [] } : sk)),
    );
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

  const activeMcpCount = servers.filter((s) => s.enabled).length;
  const activeSkillCount = skills.filter((s) => s.enabled).length;

  return (
    <form
      onSubmit={onSave}
      className="panel"
      style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '22px' }}
    >
      {/* SECTION 1: MCP SERVER REGISTRY */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <span className="eyebrow">Model Context Protocol (MCP) Hub</span>
            <h3 style={{ margin: '4px 0 4px' }}>
              <Plug className="icon" aria-hidden /> MCP Tool Servers ({activeMcpCount} of {servers.length} Active)
            </h3>
            <p className="muted small" style={{ maxWidth: 740, margin: 0 }}>
              Enable curated or custom MCP servers and scope them to specific specialist personas. Active MCP servers are automatically wired into <code>--mcp-config</code> and pre-authorized in autonomous runs.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowAddMcp((v) => !v)}
          >
            {showAddMcp ? (
              'Cancel'
            ) : (
              <>
                <Plus className="icon" aria-hidden /> Add Custom MCP Server
              </>
            )}
          </button>
        </div>

        {showAddMcp && (
          <div
            style={{
              padding: '14px',
              borderRadius: '8px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <strong style={{ fontSize: '0.85rem' }}>Register Custom MCP Server</strong>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '10px',
              }}
            >
              <label className="field" style={{ gap: 4 }}>
                <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                  Server Name
                </span>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Stripe / Supabase / Custom MCP"
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                />
              </label>
              <label className="field" style={{ gap: 4 }}>
                <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                  Server ID (Slug)
                </span>
                <input
                  type="text"
                  className="input mono"
                  placeholder="e.g. stripe-mcp (auto if blank)"
                  value={mcpId}
                  onChange={(e) => setMcpId(e.target.value)}
                />
              </label>
              <label className="field" style={{ gap: 4 }}>
                <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                  Transport
                </span>
                <select
                  className="input"
                  value={mcpTransport}
                  onChange={(e) => setMcpTransport(e.target.value as McpServerTransport)}
                >
                  <option value="stdio">stdio (CLI Command &amp; Args)</option>
                  <option value="sse">sse (HTTP Server-Sent Events URL)</option>
                  <option value="http">http (Streamable HTTP URL)</option>
                </select>
              </label>
            </div>

            {mcpTransport === 'stdio' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr',
                  gap: '10px',
                }}
              >
                <label className="field" style={{ gap: 4 }}>
                  <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                    Command
                  </span>
                  <input
                    type="text"
                    className="input mono"
                    placeholder="npx"
                    value={mcpCommand}
                    onChange={(e) => setMcpCommand(e.target.value)}
                  />
                </label>
                <label className="field" style={{ gap: 4 }}>
                  <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                    Arguments (space-separated)
                  </span>
                  <input
                    type="text"
                    className="input mono"
                    placeholder="-y @upstash/context7-mcp"
                    value={mcpArgs}
                    onChange={(e) => setMcpArgs(e.target.value)}
                  />
                </label>
              </div>
            ) : (
              <label className="field" style={{ gap: 4 }}>
                <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                  Endpoint URL
                </span>
                <input
                  type="url"
                  className="input mono"
                  placeholder="http://localhost:8080/mcp"
                  value={mcpUrl}
                  onChange={(e) => setMcpUrl(e.target.value)}
                />
              </label>
            )}

            <label className="field" style={{ gap: 4 }}>
              <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                Description
              </span>
              <input
                type="text"
                className="input"
                placeholder="What tools does this MCP server provide to your agents?"
                value={mcpDesc}
                onChange={(e) => setMcpDesc(e.target.value)}
              />
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={handleCreateCustomMcp}
                disabled={!mcpName.trim()}
              >
                Add MCP Server to Registry
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))',
            gap: '10px',
          }}
        >
          {servers.map((srv) => {
            const cmdPreview =
              srv.transport === 'stdio'
                ? `${srv.command} ${srv.args.join(' ')}`.trim()
                : (srv.url ?? '');
            return (
              <div
                key={srv.id}
                style={{
                  padding: '13px',
                  borderRadius: '8px',
                  background: srv.enabled ? 'var(--surface-2)' : 'color-mix(in srgb, var(--text) 1.5%, transparent)',
                  border: srv.enabled
                    ? '1px solid color-mix(in srgb, var(--info) 45%, transparent)'
                    : '1px dashed var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <span style={{ fontSize: '1.05rem' }}>{srv.icon}</span>
                      <strong style={{ fontSize: '0.88rem' }}>{srv.name}</strong>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <button
                        type="button"
                        className={`btn btn-xs ${srv.enabled ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => toggleMcpEnabled(srv.id)}
                      >
                        {srv.enabled ? '✓ Active' : '+ Enable'}
                      </button>
                      {!srv.builtIn && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={() => removeCustomMcp(srv.id)}
                          title="Remove custom MCP server"
                          aria-label="Remove custom MCP server"
                        >
                          <X className="icon" aria-hidden />
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span className="badge mono" style={{ fontSize: '0.64rem' }}>
                      mcp__{srv.id}__*
                    </span>
                    <span className="badge mono" style={{ fontSize: '0.64rem' }}>
                      {srv.transport.toUpperCase()}
                    </span>
                    {!srv.builtIn && (
                      <span className="badge mono" style={{ fontSize: '0.64rem', color: 'var(--info)' }}>
                        Custom
                      </span>
                    )}
                  </div>

                  <div className="muted small" style={{ fontSize: '0.73rem', lineHeight: 1.35 }}>
                    {srv.description}
                  </div>

                  <code
                    className="mono muted"
                    style={{
                      fontSize: '0.67rem',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      background: 'var(--surface-2)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={cmdPreview}
                  >
                    {cmdPreview}
                  </code>
                </div>

                {/* Persona Scope Pills */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span className="muted mono" style={{ fontSize: '0.65rem' }}>
                    Persona Scope ({srv.personas.length === 0 ? 'All Personas' : `${srv.personas.length} Selected`})
                  </span>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => setMcpAllPersonas(srv.id)}
                      className="mono"
                      style={{
                        fontSize: '0.64rem',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        background:
                          srv.personas.length === 0 ? 'color-mix(in srgb, var(--info) 20%, transparent)' : 'transparent',
                        border:
                          srv.personas.length === 0
                            ? '1px solid color-mix(in srgb, var(--info) 50%, transparent)'
                            : '1px solid var(--border)',
                        color: srv.personas.length === 0 ? 'var(--info)' : 'var(--text-muted)',
                      }}
                    >
                      ALL
                    </button>
                    {PERSONA_LIST.map((p) => {
                      const active = srv.personas.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => toggleMcpPersona(srv.id, p.id)}
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
                          title={`Toggle ${p.label} access to ${srv.name}`}
                        >
                          {p.shortLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

      {/* SECTION 2: SKILL & RULE PLUGINS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <span className="eyebrow">Reusable Agent Skills &amp; Craftsmanship Rules</span>
            <h3 style={{ margin: '4px 0 4px' }}>
              <Puzzle className="icon" aria-hidden /> Skill &amp; Rule Plugins ({activeSkillCount} of {skills.length} Active)
            </h3>
            <p className="muted small" style={{ maxWidth: 740, margin: 0 }}>
              Modular domain skills and coding standards injected into matching specialist personas on launch. Built-in skills come enabled out of the box; you can also author custom team rules below.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowAddSkill((v) => !v)}
          >
            {showAddSkill ? (
              'Cancel'
            ) : (
              <>
                <Plus className="icon" aria-hidden /> Add Custom Skill Plugin
              </>
            )}
          </button>
        </div>

        {showAddSkill && (
          <div
            style={{
              padding: '14px',
              borderRadius: '8px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <strong style={{ fontSize: '0.85rem' }}>Create Custom Skill / Rule Plugin</strong>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '10px',
              }}
            >
              <label className="field" style={{ gap: 4 }}>
                <span className="muted mono" style={{ fontSize: '0.68rem' }}>
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
              <label className="field" style={{ gap: 4 }}>
                <span className="muted mono" style={{ fontSize: '0.68rem' }}>
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
              <label className="field" style={{ gap: 4 }}>
                <span className="muted mono" style={{ fontSize: '0.68rem' }}>
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

            <label className="field" style={{ gap: 4 }}>
              <span className="muted mono" style={{ fontSize: '0.68rem' }}>
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

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))',
            gap: '10px',
          }}
        >
          {skills.map((sk) => (
            <div
              key={sk.id}
              style={{
                padding: '13px',
                borderRadius: '8px',
                background: sk.enabled ? 'var(--surface-2)' : 'color-mix(in srgb, var(--text) 1.5%, transparent)',
                border: sk.enabled
                  ? '1px solid color-mix(in srgb, var(--ok) 45%, transparent)'
                  : '1px dashed var(--border)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
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
                        <X className="icon" aria-hidden />
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span className="badge mono" style={{ fontSize: '0.64rem' }}>
                    {sk.category.toUpperCase()}
                  </span>
                  <span className="badge mono" style={{ fontSize: '0.64rem' }}>
                    {sk.builtIn ? 'Built-In Skill' : 'Custom Skill'}
                  </span>
                </div>

                <div className="muted small" style={{ fontSize: '0.73rem', lineHeight: 1.35 }}>
                  {sk.description}
                </div>
              </div>

              {/* Persona Scope Pills */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="muted mono" style={{ fontSize: '0.65rem' }}>
                  Target Personas ({sk.personas.length === 0 ? 'All Personas' : `${sk.personas.length} Selected`})
                </span>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setSkillAllPersonas(sk.id)}
                    className="mono"
                    style={{
                      fontSize: '0.64rem',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background:
                        sk.personas.length === 0 ? 'color-mix(in srgb, var(--info) 20%, transparent)' : 'transparent',
                      border:
                        sk.personas.length === 0
                          ? '1px solid color-mix(in srgb, var(--info) 50%, transparent)'
                          : '1px solid var(--border)',
                      color: sk.personas.length === 0 ? 'var(--info)' : 'var(--text-muted)',
                    }}
                  >
                    ALL
                  </button>
                  {PERSONA_LIST.map((p) => {
                    const active = sk.personas.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => toggleSkillPersona(sk.id, p.id)}
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
                      >
                        {p.shortLabel}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? (
            'Saving…'
          ) : (
            <>
              <Save className="icon" aria-hidden /> Save MCP &amp; Plugin Configuration
            </>
          )}
        </button>
      </div>
    </form>
  );
}
