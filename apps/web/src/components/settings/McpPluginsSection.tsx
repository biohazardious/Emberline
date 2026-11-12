import type { AgentPersona, McpServerEntry, McpServerTransport, SkillPluginEntry } from '@emberline/protocol';
import { Plug, Plus, Save, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ico, SectionState } from '../SectionState';
import { PersonaScopePills, SkillPluginsSection } from './SkillPluginsSection';
import {
  ST_BADGE_64,
  ST_CARD_GRID_310,
  ST_COL_6,
  ST_COL_14,
  ST_CUSTOM_BOX,
  ST_DESC_73,
  ST_FIELD_4,
  ST_HEAD_SPLIT,
  ST_HR,
  ST_LABEL_68,
  ST_PANEL_FORM,
  ST_PANEL_PAD,
  ST_ROW_BETWEEN,
  ST_ROW_WRAP6,
  ST_SAVE_ROW,
} from './settingsMeta';

export interface McpPluginsSectionProps {
  mcpServers: McpServerEntry[];
  skillPlugins: SkillPluginEntry[];
  saving: boolean;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => Promise<void>;
  onChangeMcpServers: (next: McpServerEntry[]) => void;
  onChangeSkillPlugins: (next: SkillPluginEntry[]) => void;
  onSave: (e: FormEvent) => void;
}

export function McpPluginsSection({
  mcpServers: servers,
  skillPlugins: skills,
  saving,
  loading,
  loadError,
  onRetry,
  onChangeMcpServers,
  onChangeSkillPlugins,
  onSave,
}: McpPluginsSectionProps) {
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [mcpId, setMcpId] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpDesc, setMcpDesc] = useState('');
  const [mcpTransport, setMcpTransport] = useState<McpServerTransport>('stdio');
  const [mcpCommand, setMcpCommand] = useState('npx');
  const [mcpArgs, setMcpArgs] = useState('-y @modelcontextprotocol/server-everything');
  const [mcpUrl, setMcpUrl] = useState('');

  if ((loadError !== undefined || loading) && servers.length === 0 && skills.length === 0) {
    return (
      <SectionState
        loading={loading}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading MCP servers & skill plugins…"
        emptyText="No MCP servers or skill plugins registered."
        errorPrefix="Could not load MCP & plugin registry"
        style={ST_PANEL_PAD}
      />
    );
  }

  const toggleMcpEnabled = (id: string) => {
    onChangeMcpServers(servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  };

  const toggleMcpPersona = (id: string, persona: AgentPersona) => {
    onChangeMcpServers(
      servers.map((s) => {
        if (s.id !== id) return s;
        const exists = s.personas.includes(persona);
        const nextPersonas = exists ? s.personas.filter((p) => p !== persona) : [...s.personas, persona];
        return { ...s, personas: nextPersonas };
      }),
    );
  };

  const setMcpAllPersonas = (id: string) => {
    onChangeMcpServers(servers.map((s) => (s.id === id ? { ...s, personas: [] } : s)));
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
      args: mcpTransport === 'stdio' ? mcpArgs.trim().split(/\s+/).filter(Boolean) : [],
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

  const activeMcpCount = servers.filter((s) => s.enabled).length;

  return (
    <form onSubmit={onSave} className="panel" style={ST_PANEL_FORM}>
      <div style={ST_COL_14}>
        <div style={ST_HEAD_SPLIT}>
          <div>
            <span className="eyebrow">Model Context Protocol (MCP) Hub</span>
            <h3 style={{ margin: '4px 0 4px' }}>
              {ico(Plug)} MCP Tool Servers ({activeMcpCount} of {servers.length} Active)
            </h3>
            <p className="muted small" style={{ maxWidth: 740, margin: 0 }}>
              Enable curated or custom MCP servers and scope them to specific specialist personas. Active MCP
              servers are automatically wired into <code>--mcp-config</code> and pre-authorized in autonomous
              runs.
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setShowAddMcp((v) => !v)}>
            {showAddMcp ? 'Cancel' : <>{ico(Plus)} Add Custom MCP Server</>}
          </button>
        </div>

        {showAddMcp && (
          <div style={ST_CUSTOM_BOX}>
            <strong style={{ fontSize: '0.85rem' }}>Register Custom MCP Server</strong>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))',
                gap: '10px',
              }}
            >
              <label className="field" style={ST_FIELD_4}>
                <span className="muted mono" style={ST_LABEL_68}>
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
              <label className="field" style={ST_FIELD_4}>
                <span className="muted mono" style={ST_LABEL_68}>
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
              <label className="field" style={ST_FIELD_4}>
                <span className="muted mono" style={ST_LABEL_68}>
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
              <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '10px' }}>
                <label className="field" style={ST_FIELD_4}>
                  <span className="muted mono" style={ST_LABEL_68}>
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
                <label className="field" style={ST_FIELD_4}>
                  <span className="muted mono" style={ST_LABEL_68}>
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
              <label className="field" style={ST_FIELD_4}>
                <span className="muted mono" style={ST_LABEL_68}>
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

            <label className="field" style={ST_FIELD_4}>
              <span className="muted mono" style={ST_LABEL_68}>
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

            <div style={ST_SAVE_ROW}>
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

        {servers.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No MCP tool servers registered yet.
          </p>
        ) : (
          <div style={ST_CARD_GRID_310}>
            {servers.map((srv) => {
              const cmdPreview =
                srv.transport === 'stdio' ? `${srv.command} ${srv.args.join(' ')}`.trim() : (srv.url ?? '');
              return (
                <div
                  key={srv.id}
                  style={{
                    padding: '13px',
                    borderRadius: '8px',
                    background: srv.enabled
                      ? 'var(--surface-2)'
                      : 'color-mix(in srgb, var(--text) 1.5%, transparent)',
                    border: srv.enabled
                      ? '1px solid color-mix(in srgb, var(--info) 45%, transparent)'
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
                            {ico(X)}
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={ST_ROW_WRAP6}>
                      <span className="badge mono" style={ST_BADGE_64}>
                        mcp__{srv.id}__*
                      </span>
                      <span className="badge mono" style={ST_BADGE_64}>
                        {srv.transport.toUpperCase()}
                      </span>
                      {!srv.builtIn && (
                        <span className="badge mono" style={{ ...ST_BADGE_64, color: 'var(--info)' }}>
                          Custom
                        </span>
                      )}
                    </div>

                    <div className="muted small" style={ST_DESC_73}>
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

                  <PersonaScopePills
                    labelPrefix="Persona Scope"
                    personas={srv.personas}
                    onSelectAll={() => setMcpAllPersonas(srv.id)}
                    onToggle={(persona) => toggleMcpPersona(srv.id, persona)}
                    itemTitle={srv.name}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <hr style={ST_HR} />

      <SkillPluginsSection skills={skills} onChangeSkillPlugins={onChangeSkillPlugins} />

      <div style={ST_SAVE_ROW}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : <>{ico(Save)} Save MCP &amp; Plugin Configuration</>}
        </button>
      </div>
    </form>
  );
}
