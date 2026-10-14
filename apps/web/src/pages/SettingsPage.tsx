import type {
  AgentId,
  AgentModelId,
  FactorySettings,
  PersonaAgentMap,
  PersonaModelMap,
  ThemeMode,
} from '@emberline/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { PERSONA_LIST } from '../components/PersonaBadge';
import { QuotaPanel } from '../components/QuotaPanel';

const AGENT_OPTIONS: Array<{ id: AgentId; label: string; desc: string }> = [
  { id: 'claude', label: 'Claude Code (Anthropic)', desc: 'Full hook telemetry + Fable/Opus/Sonnet tiers' },
  { id: 'antigravity', label: 'Antigravity CLI (agy)', desc: 'Argon / Gemini specialist for Frontend & UI/UX' },
  { id: 'copilot', label: 'GitHub Copilot CLI', desc: 'Fast shell/git/code assistant & PR specialist' },
  { id: 'gemini', label: 'Gemini CLI (Google)', desc: 'Fast multimodal & large-context reasoning' },
  { id: 'codex', label: 'Codex CLI (OpenAI)', desc: 'OpenAI o3 / GPT-4.1 coding specialist' },
  { id: 'aider', label: 'Aider CLI (Multi-Model)', desc: 'Git-centric pair programmer' },
];

const MODEL_OPTIONS: Array<{ id: AgentModelId; label: string; badge: string }> = [
  { id: 'fable', label: 'Claude Fable — Deep Architecture & Spec Analysis', badge: 'Deep Analysis' },
  { id: 'opus', label: 'Claude Opus — High-Power Backend & Core Engineering', badge: 'Core Power' },
  { id: 'sonnet', label: 'Claude Sonnet — Fast Search, QA & Low-Token Tasks', badge: 'Token Saver' },
  { id: 'haiku', label: 'Claude Haiku — Ultra-Light Quick Edits', badge: 'Ultra-Light' },
  { id: 'argon', label: 'Antigravity Argon — Frontend, UI/UX & Interactive Design', badge: 'Frontend UI' },
  { id: 'gemini-pro', label: 'Gemini 2.5 Pro — Large Codebase Context', badge: '1M Context' },
  { id: 'gpt-4o', label: 'GPT-4o / Codex — Fast General Coding', badge: 'General' },
  { id: 'auto', label: 'Auto (Default CLI Model)', badge: 'Default' },
];

export function SettingsPage({
  theme,
  onChangeTheme,
}: {
  theme: 'dark' | 'light';
  onChangeTheme: (theme: 'dark' | 'light') => void;
}) {
  const [activeTab, setActiveTab] = useState<'autopilot' | 'providers' | 'quota' | 'notifications'>(
    'autopilot',
  );
  const [settings, setSettings] = useState<FactorySettings | null>(null);
  const [themePref, setThemePref] = useState<ThemeMode>(theme);
  const [autoPickupReady, setAutoPickupReady] = useState(true);
  const [autoPickupBacklog, setAutoPickupBacklog] = useState(false);
  const [autoSyncToMain, setAutoSyncToMain] = useState(true);
  const [selfHealingBuildGate, setSelfHealingBuildGate] = useState(true);
  const [autoMoveToDone, setAutoMoveToDone] = useState(true);
  const [quotaAutoDowngrade, setQuotaAutoDowngrade] = useState(true);
  const [defaultAgent, setDefaultAgent] = useState<AgentId>('claude');
  const [personaAgents, setPersonaAgents] = useState<PersonaAgentMap>({
    product_owner: 'claude',
    architect: 'claude',
    ui_ux: 'antigravity',
    coder: 'claude',
    dba: 'claude',
    qa: 'claude',
    security: 'claude',
  });
  const [personaModels, setPersonaModels] = useState<PersonaModelMap>({
    product_owner: 'fable',
    architect: 'fable',
    ui_ux: 'argon',
    coder: 'opus',
    dba: 'opus',
    qa: 'sonnet',
    security: 'opus',
  });

  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<FactorySettings>('/api/factory/settings')
      .then((res) => {
        setSettings(res);
        setThemePref(res.theme);
        setAutoPickupReady(res.autoPickupReady);
        setAutoPickupBacklog(res.autoPickupBacklog);
        setAutoSyncToMain(res.autoSyncToMain);
        setSelfHealingBuildGate(res.selfHealingBuildGate);
        setAutoMoveToDone(res.autoMoveToDone);
        setQuotaAutoDowngrade(res.quotaAutoDowngrade ?? true);
        setDefaultAgent(res.defaultAgent);
        setPersonaAgents(res.personaAgents);
        if (res.personaModels) setPersonaModels(res.personaModels);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const applyRoutingPreset = (preset: 'visionary' | 'claude-tiered' | 'token-saver') => {
    if (preset === 'visionary') {
      setPersonaAgents({
        product_owner: 'claude',
        architect: 'claude',
        ui_ux: 'antigravity',
        coder: 'claude',
        dba: 'claude',
        qa: 'claude',
        security: 'claude',
      });
      setPersonaModels({
        product_owner: 'fable',
        architect: 'fable',
        ui_ux: 'argon',
        coder: 'opus',
        dba: 'opus',
        qa: 'sonnet',
        security: 'opus',
      });
      setNotice('Applied "Visionary Multi-Agent Orchestra" preset (Fable for PO/Arch, Antigravity Argon for UI/UX, Opus for Backend, Sonnet for QA). Click Save to persist.');
    } else if (preset === 'claude-tiered') {
      setPersonaAgents({
        product_owner: 'claude',
        architect: 'claude',
        ui_ux: 'claude',
        coder: 'claude',
        dba: 'claude',
        qa: 'claude',
        security: 'claude',
      });
      setPersonaModels({
        product_owner: 'fable',
        architect: 'fable',
        ui_ux: 'opus',
        coder: 'opus',
        dba: 'opus',
        qa: 'sonnet',
        security: 'opus',
      });
      setNotice('Applied "Claude All-Tier (Fable + Opus + Sonnet)" preset. Click Save to persist.');
    } else {
      setPersonaAgents({
        product_owner: 'claude',
        architect: 'claude',
        ui_ux: 'claude',
        coder: 'claude',
        dba: 'claude',
        qa: 'claude',
        security: 'claude',
      });
      setPersonaModels({
        product_owner: 'opus',
        architect: 'opus',
        ui_ux: 'sonnet',
        coder: 'sonnet',
        dba: 'sonnet',
        qa: 'sonnet',
        security: 'sonnet',
      });
      setNotice('Applied "Low-Token Economy (Sonnet-First)" preset. Click Save to persist.');
    }
  };

  const handleSaveFactorySettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        theme: themePref,
        autoPickupReady,
        autoPickupBacklog,
        autoSyncToMain,
        selfHealingBuildGate,
        autoMoveToDone,
        quotaAutoDowngrade,
        defaultAgent,
        personaAgents,
        personaModels,
      };
      if (anthropicApiKey.trim()) payload.anthropicApiKey = anthropicApiKey.trim();
      if (openaiApiKey.trim()) payload.openaiApiKey = openaiApiKey.trim();
      if (geminiApiKey.trim()) payload.geminiApiKey = geminiApiKey.trim();

      const updated = await api<FactorySettings>('/api/factory/settings', 'PATCH', payload);
      setSettings(updated);
      setAnthropicApiKey('');
      setOpenaiApiKey('');
      setGeminiApiKey('');
      if (themePref === 'light' || themePref === 'dark') {
        onChangeTheme(themePref);
      }
      setNotice('Factory settings & Multi-Agent Model Routing saved and applied.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <header
        className="panel"
        style={{
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <span className="eyebrow">Control Center</span>
          <h2 style={{ margin: '4px 0 0' }}>⚙ Factory Settings &amp; Multi-Agent Model Routing</h2>
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'autopilot' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('autopilot')}
          >
            ⚡ Auto-Pilot &amp; Theme
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'providers' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('providers')}
          >
            🤖 Multi-Agent &amp; Model Matrix
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'quota' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('quota')}
          >
            ⏱️ Quota &amp; Concurrency
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'notifications' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('notifications')}
          >
            🔔 Forge &amp; Webhooks
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {notice && <div className="banner banner-ok">{notice}</div>}

      {activeTab === 'autopilot' && (
        <form
          onSubmit={(e) => void handleSaveFactorySettings(e)}
          className="panel"
          style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}
        >
          <div>
            <span className="eyebrow">Appearance</span>
            <h3 style={{ margin: '4px 0 8px' }}>Theme Mode</h3>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn ${theme === 'dark' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => {
                  setThemePref('dark');
                  onChangeTheme('dark');
                }}
              >
                🌙 Dark Workbench
              </button>
              <button
                type="button"
                className={`btn ${theme === 'light' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => {
                  setThemePref('light');
                  onChangeTheme('light');
                }}
              >
                ☀️ Light Workbench
              </button>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <span className="eyebrow">Autonomous Pipeline</span>
              <h3 style={{ margin: '4px 0 4px' }}>Backlog &amp; Ready Auto-Pickup + Self-Healing</h3>
              <p className="muted small">
                Configure how the AI Coding Factory chains specialist tickets, verifies builds, and updates the live workspace.
              </p>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoPickupReady}
                onChange={(e) => setAutoPickupReady(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Pickup Ready Queue</strong>
                <div className="muted small">
                  Automatically start the highest-priority ticket in the <code>Ready</code> column as soon as the previous specialist finishes.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoPickupBacklog}
                onChange={(e) => setAutoPickupBacklog(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Pickup Backlog Queue (Continuous Factory Mode)</strong>
                <div className="muted small">
                  When the <code>Ready</code> column is empty during an active pipeline run, automatically pull the next highest-priority ticket from <code>Backlog</code>.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selfHealingBuildGate}
                onChange={(e) => setSelfHealingBuildGate(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Self-Healing Build Gate (Auto-Verify &amp; Auto-Fix Compile Errors)</strong>
                <div className="muted small">
                  When a specialist finishes a run on a project with a <code>build</code> script, automatically run the build. If it fails, resume the agent with the compiler output to self-heal before advancing.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoSyncToMain}
                onChange={(e) => setAutoSyncToMain(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Sync Completed Worktrees into Main Host Workspace</strong>
                <div className="muted small">
                  Automatically copy &amp; commit completed specialist files into <code>/workspaces/&lt;slug&gt;</code> so subsequent specialists and the Live Demo stay up to date.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoMoveToDone}
                onChange={(e) => setAutoMoveToDone(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Move Verified Factory Tickets to Done</strong>
                <div className="muted small">
                  Move factory pipeline tickets directly to the <code>Done</code> column once their build and sync succeed.
                </div>
              </div>
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : '💾 Save Auto-Pilot & Theme Settings'}
            </button>
          </div>
        </form>
      )}

      {activeTab === 'providers' && (
        <form
          onSubmit={(e) => void handleSaveFactorySettings(e)}
          className="panel"
          style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <span className="eyebrow">Multi-CLI &amp; Autonomous Model Routing</span>
                <h3 style={{ margin: '4px 0 6px' }}>Per-Persona Agent &amp; Model Matrix</h3>
                <p className="muted small" style={{ maxWidth: 680 }}>
                  Route each specialist persona to the optimal CLI engine (<code>claude</code>, <code>antigravity</code>, <code>copilot</code>, <code>gemini</code>, <code>codex</code>, <code>aider</code>) and model tier (<code>fable</code> for deep analysis, <code>argon</code> for frontend/UI, <code>opus</code> for core backend, <code>sonnet</code> for low-token search/QA).
                </p>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => applyRoutingPreset('visionary')}
                  title="Fable for PO/Arch, Antigravity Argon for UI/UX, Claude Opus for Coder/DBA/Sec, Claude Sonnet for QA"
                >
                  ⚡ Visionary Multi-Agent Preset
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => applyRoutingPreset('claude-tiered')}
                  title="Claude Fable + Opus + Sonnet across all roles"
                >
                  🧠 Claude All-Tier
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => applyRoutingPreset('token-saver')}
                  title="Prioritize Claude Sonnet to minimize token consumption"
                >
                  💰 Token Saver (Sonnet)
                </button>
              </div>
            </div>

            <label
              style={{
                marginTop: 10,
                padding: '10px 12px',
                borderRadius: 'var(--radius)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={quotaAutoDowngrade}
                onChange={(e) => setQuotaAutoDowngrade(e.target.checked)}
              />
              <span style={{ fontSize: '0.82rem' }}>
                <strong>Quota-Aware Autonomous Model Routing:</strong> Automatically prefer low-token models (<code>sonnet</code>) for routine search, verification, and QA tasks to preserve your 5-hour &amp; 7-day rate limits.
              </span>
            </label>

            <div
              style={{
                marginTop: '14px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: '10px',
              }}
            >
              {PERSONA_LIST.map((meta) => {
                const personaKey = meta.id;
                return (
                  <div
                    key={personaKey}
                    style={{
                      padding: '12px',
                      borderRadius: '6px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                      <strong>{meta.label}</strong>
                      <span className="badge mono">{meta.shortLabel}</span>
                    </div>
                    <div className="muted small" style={{ fontSize: '0.72rem' }}>
                      {meta.hint}
                    </div>
                    <label className="field" style={{ gap: 3 }}>
                      <span className="muted mono" style={{ fontSize: '0.7rem' }}>CLI Agent</span>
                      <select
                        className="input"
                        value={personaAgents[personaKey]}
                        onChange={(e) =>
                          setPersonaAgents((prev) => ({
                            ...prev,
                            [personaKey]: e.target.value as AgentId,
                          }))
                        }
                      >
                        {AGENT_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field" style={{ gap: 3 }}>
                      <span className="muted mono" style={{ fontSize: '0.7rem' }}>Model Tier</span>
                      <select
                        className="input"
                        value={personaModels[personaKey] ?? 'auto'}
                        onChange={(e) =>
                          setPersonaModels((prev) => ({
                            ...prev,
                            [personaKey]: e.target.value as AgentModelId,
                          }))
                        }
                      >
                        {MODEL_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

          <div>
            <span className="eyebrow">Provider Credentials</span>
            <h3 style={{ margin: '4px 0 6px' }}>API Keys (Optional Override)</h3>
            <p className="muted small">
              Keys are stored in SQLite and injected into agent PTY environments (<code>ANTHROPIC_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>OPENAI_API_KEY</code>). Leave blank to use your existing host CLI login.
            </p>

            <div
              style={{
                marginTop: '12px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: '12px',
              }}
            >
              <label className="field">
                <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Anthropic API Key (Claude)</span>
                  <span className="badge mono">
                    {settings?.anthropicKeyConfigured ? '✓ Configured' : 'Host Auth'}
                  </span>
                </span>
                <input
                  type="password"
                  className="input mono"
                  placeholder={settings?.anthropicKeyConfigured ? '••••••••••••••••' : 'sk-ant-...'}
                  value={anthropicApiKey}
                  onChange={(e) => setAnthropicApiKey(e.target.value)}
                />
              </label>

              <label className="field">
                <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Google Gemini API Key (Gemini CLI)</span>
                  <span className="badge mono">
                    {settings?.geminiKeyConfigured ? '✓ Configured' : 'Not set'}
                  </span>
                </span>
                <input
                  type="password"
                  className="input mono"
                  placeholder={settings?.geminiKeyConfigured ? '••••••••••••••••' : 'AIzaSy...'}
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                />
              </label>

              <label className="field">
                <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>OpenAI API Key (Codex / Aider)</span>
                  <span className="badge mono">
                    {settings?.openaiKeyConfigured ? '✓ Configured' : 'Not set'}
                  </span>
                </span>
                <input
                  type="password"
                  className="input mono"
                  placeholder={settings?.openaiKeyConfigured ? '••••••••••••••••' : 'sk-proj-...'}
                  value={openaiApiKey}
                  onChange={(e) => setOpenaiApiKey(e.target.value)}
                />
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : '💾 Save AI Providers & Persona Routing'}
            </button>
          </div>
        </form>
      )}

      {activeTab === 'quota' && <QuotaPanel />}
      {activeTab === 'notifications' && <NotificationsPanel />}
    </div>
  );
}
