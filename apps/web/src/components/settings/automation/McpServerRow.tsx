import type { AgentPersona, McpServerEntry } from '@emberline/protocol';
import { useEffect, useState } from 'react';
import { SettingRow } from '../../ui/SettingRow';
import { Switch } from '../../ui/Switch';
import { PersonaScopePills } from './SkillPluginRow';

export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function parseEnvLines(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function McpServerRow({
  server,
  onToggleEnabled,
  onTogglePersona,
  onSelectAllPersonas,
  onUpdate,
  onRemove,
}: {
  server: McpServerEntry;
  onToggleEnabled: (id: string) => void;
  onTogglePersona: (id: string, persona: AgentPersona) => void;
  onSelectAllPersonas: (id: string) => void;
  onUpdate: (id: string, patch: Partial<McpServerEntry>) => void;
  onRemove: (id: string) => void;
}) {
  const joinedArgs = server.args.join(' ');
  const formattedEnv = formatEnvLines(server.env);
  const [argsInput, setArgsInput] = useState(joinedArgs);
  const [envInput, setEnvInput] = useState(formattedEnv);

  useEffect(() => {
    setArgsInput(joinedArgs);
  }, [joinedArgs]);

  useEffect(() => {
    setEnvInput(formattedEnv);
  }, [formattedEnv]);

  const cmdPreview =
    server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : (server.url ?? '');

  return (
    <SettingRow
      label={server.name}
      summary={server.description}
      control={
        <>
          {!server.builtIn && (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              aria-label={`Remove ${server.name}`}
              onClick={() => onRemove(server.id)}
            >
              Remove
            </button>
          )}
          <Switch
            checked={server.enabled}
            onChange={() => onToggleEnabled(server.id)}
            ariaLabel={`Enable ${server.name}`}
          />
        </>
      }
      details={
        <div className="settings-detail-stack">
          <div className="settings-detail-meta">
            <span className="badge mono">mcp__{server.id}__*</span>
            <span className="badge mono">{server.transport.toUpperCase()}</span>
            <span className="badge mono">{server.builtIn ? 'Built-in' : 'Custom'}</span>
            {cmdPreview && <code className="mono settings-code-pill">{cmdPreview}</code>}
          </div>

          {server.transport === 'stdio' ? (
            <div className="settings-stdio-grid">
              <label className="field">
                <span>Command</span>
                <input
                  type="text"
                  className="input mono"
                  aria-label={`Command for ${server.name}`}
                  value={server.command}
                  onChange={(e) => onUpdate(server.id, { command: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Arguments</span>
                <input
                  type="text"
                  className="input mono"
                  aria-label={`Arguments for ${server.name}`}
                  value={argsInput}
                  onChange={(e) => {
                    const nextRaw = e.target.value;
                    setArgsInput(nextRaw);
                    onUpdate(server.id, {
                      args: nextRaw.trim() ? nextRaw.trim().split(/\s+/).filter(Boolean) : [],
                    });
                  }}
                />
              </label>
            </div>
          ) : (
            <label className="field">
              <span>Endpoint URL</span>
              <input
                type="url"
                className="input mono"
                aria-label={`Endpoint URL for ${server.name}`}
                value={server.url ?? ''}
                onChange={(e) => onUpdate(server.id, { url: e.target.value.trim() || null })}
              />
            </label>
          )}

          <label className="field">
            <span>Environment variables</span>
            <textarea
              className="input mono"
              rows={2}
              placeholder="KEY=value"
              aria-label={`Environment variables for ${server.name}`}
              value={envInput}
              onChange={(e) => {
                const nextRaw = e.target.value;
                setEnvInput(nextRaw);
                onUpdate(server.id, { env: parseEnvLines(nextRaw) });
              }}
            />
          </label>

          <PersonaScopePills
            personas={server.personas}
            onSelectAll={() => onSelectAllPersonas(server.id)}
            onToggle={(persona) => onTogglePersona(server.id, persona)}
            itemTitle={server.name}
          />
        </div>
      }
    />
  );
}
