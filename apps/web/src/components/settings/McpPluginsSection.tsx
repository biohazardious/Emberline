import type { AgentPersona, McpServerEntry, McpServerTransport, SkillPluginEntry } from '@emberline/protocol';
import { type FormEvent, useState } from 'react';
import { SectionState } from '../SectionState';
import { HelpHint } from '../ui/HelpHint';
import { SaveBar } from '../ui/SaveBar';
import { McpServerRow, parseEnvLines } from './automation/McpServerRow';
import './settings-sections.css';
import { SkillPluginsSection } from './SkillPluginsSection';

export interface McpPluginsSectionProps {
  mcpServers: McpServerEntry[];
  skillPlugins: SkillPluginEntry[];
  dirty?: boolean;
  onDiscard?: () => void;
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
  dirty = false,
  onDiscard = () => undefined,
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
  const [mcpEnv, setMcpEnv] = useState('');

  if ((loadError !== undefined || loading) && servers.length === 0 && skills.length === 0) {
    return (
      <SectionState
        loading={loading}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading MCP servers & skill plugins…"
        emptyText="No MCP servers or skill plugins registered."
        errorPrefix="Could not load MCP & plugin registry"
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

  const updateMcpServer = (id: string, patch: Partial<McpServerEntry>) => {
    onChangeMcpServers(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
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
      env: parseEnvLines(mcpEnv),
      enabled: true,
      builtIn: false,
      personas: [],
    };

    onChangeMcpServers([...servers.filter((s) => s.id !== slug), entry]);
    setMcpId('');
    setMcpName('');
    setMcpDesc('');
    setMcpEnv('');
    setShowAddMcp(false);
  };

  const activeMcpCount = servers.filter((s) => s.enabled).length;

  return (
    <form onSubmit={onSave} className="panel settings-section-form">
      <section className="settings-group" aria-labelledby="mcp-servers-heading">
        <header className="settings-group-head settings-group-head-split">
          <div className="settings-group-title-row">
            <h2 id="mcp-servers-heading">MCP servers</h2>
            <span className="badge mono">
              {activeMcpCount} of {servers.length} on
            </span>
            <HelpHint topic="MCP servers">
              Active MCP servers are wired into <code>--mcp-config</code> and pre-authorized in autonomous
              runs.
            </HelpHint>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={showAddMcp}
            onClick={() => setShowAddMcp((v) => !v)}
          >
            {showAddMcp ? 'Cancel' : 'Add server'}
          </button>
        </header>

        {showAddMcp && (
          <div className="settings-add-box">
            <div className="settings-field-grid">
              <label className="field">
                <span>Server name</span>
                <input
                  type="text"
                  className="input"
                  placeholder="Stripe"
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Server ID</span>
                <input
                  type="text"
                  className="input mono"
                  placeholder="stripe-mcp"
                  value={mcpId}
                  onChange={(e) => setMcpId(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Transport</span>
                <select
                  className="input"
                  value={mcpTransport}
                  onChange={(e) => setMcpTransport(e.target.value as McpServerTransport)}
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">sse</option>
                  <option value="http">http</option>
                </select>
              </label>
            </div>

            {mcpTransport === 'stdio' ? (
              <div className="settings-stdio-grid">
                <label className="field">
                  <span>Command</span>
                  <input
                    type="text"
                    className="input mono"
                    placeholder="npx"
                    value={mcpCommand}
                    onChange={(e) => setMcpCommand(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Arguments</span>
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
              <label className="field">
                <span>Endpoint URL</span>
                <input
                  type="url"
                  className="input mono"
                  placeholder="http://localhost:8080/mcp"
                  value={mcpUrl}
                  onChange={(e) => setMcpUrl(e.target.value)}
                />
              </label>
            )}

            <label className="field">
              <span>Environment variables</span>
              <textarea
                className="input mono"
                rows={2}
                placeholder="KEY=value"
                value={mcpEnv}
                onChange={(e) => setMcpEnv(e.target.value)}
              />
            </label>

            <label className="field">
              <span>Description</span>
              <input
                type="text"
                className="input"
                placeholder="Tools provided to agents"
                value={mcpDesc}
                onChange={(e) => setMcpDesc(e.target.value)}
              />
            </label>

            <div className="settings-form-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleCreateCustomMcp}
                disabled={!mcpName.trim()}
              >
                Add server
              </button>
            </div>
          </div>
        )}

        {servers.length === 0 ? (
          <p className="muted small">No MCP tool servers registered yet.</p>
        ) : (
          <div className="settings-group-rows">
            {servers.map((srv) => (
              <McpServerRow
                key={srv.id}
                server={srv}
                onToggleEnabled={toggleMcpEnabled}
                onTogglePersona={toggleMcpPersona}
                onSelectAllPersonas={setMcpAllPersonas}
                onUpdate={updateMcpServer}
                onRemove={removeCustomMcp}
              />
            ))}
          </div>
        )}
      </section>

      <SkillPluginsSection skills={skills} onChangeSkillPlugins={onChangeSkillPlugins} />

      <SaveBar dirty={dirty} saving={saving} onDiscard={onDiscard} />
    </form>
  );
}
