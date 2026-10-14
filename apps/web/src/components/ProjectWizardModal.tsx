import type {
  CreateProjectResponse,
  ProjectAppType,
  ProjectTechStack,
} from '@emberline/protocol';
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';

const APP_TYPES: Array<{ id: ProjectAppType; label: string; desc: string }> = [
  {
    id: 'fullstack',
    label: 'Full-Stack Multi-Layer Platform',
    desc: 'Frontend + Backend API + Database monorepo (Portals, ERP/CRM, Workflow systems)',
  },
  {
    id: 'web_saas',
    label: 'Web SaaS / Portal / Form App',
    desc: 'Dashboards, multi-step operational forms, incident tracking & client apps',
  },
  {
    id: 'api_service',
    label: 'Backend API / Microservice',
    desc: 'REST/GraphQL/gRPC service, background workers, or distributed data pipeline',
  },
  {
    id: 'ai_agents',
    label: 'Multi-Agent AI / Orchestrator',
    desc: 'Autonomous agent pipelines, MCP tools, LLM routers & knowledge systems',
  },
  {
    id: 'mobile_desktop',
    label: 'Desktop / Mobile Application',
    desc: 'Tauri, Electron, Native GUI, Display/Overlay apps, Flutter or React Native',
  },
  {
    id: 'cli_tool',
    label: 'CLI / System & Infra Automation',
    desc: 'Linux/TrueNAS utilities, kernel/driver updaters, DevOps & shell/Python/Go CLI tools',
  },
  {
    id: 'embedded_iot',
    label: 'Embedded / IoT / Hardware Firmware',
    desc: 'ESP32, PlatformIO, Arduino, STM32, C/C++ firmware & I2C/SPI/UART chip tools',
  },
  {
    id: 'library',
    label: 'SDK / Package Library',
    desc: 'Reusable package, protocol SDK, or shared component library',
  },
  {
    id: 'game_interactive',
    label: 'Interactive Canvas / Game',
    desc: '2D/3D WebGL, Canvas, Phaser/Three.js or real-time simulation',
  },
  {
    id: 'custom',
    label: 'Custom Multi-Layer Project',
    desc: 'Tailored polyglot architecture and custom engineering workflow',
  },
];

const STACK_PRESETS: Array<{ label: string; stack: ProjectTechStack }> = [
  {
    label: 'Full-Stack Portal (React + Fastify + SQLite/Postgres)',
    stack: {
      language: 'TypeScript (Node 22)',
      frontend: 'React 19 + Vite',
      backend: 'Fastify + Zod',
      database: 'SQLite / PostgreSQL + Drizzle ORM',
      styling: 'Modern CSS / Design Tokens',
      testing: 'Vitest + Playwright',
    },
  },
  {
    label: 'Next.js Enterprise Portal + Postgres',
    stack: {
      language: 'TypeScript',
      frontend: 'Next.js App Router + React',
      backend: 'Next.js Route Handlers / Server Actions',
      database: 'PostgreSQL + Drizzle / Prisma',
      styling: 'Tailwind CSS',
      testing: 'Vitest + Playwright',
    },
  },
  {
    label: 'Multi-Agent AI Platform (TS / Python + MCP)',
    stack: {
      language: 'TypeScript / Python 3.12',
      frontend: 'React + Streaming Telemetry UI',
      backend: 'Fastify / FastAPI + Agent Orchestrator + MCP',
      database: 'SQLite / PostgreSQL + Vector Store',
      styling: 'Tailwind CSS / Custom Dark UI',
      testing: 'Vitest / Pytest',
    },
  },
  {
    label: 'Desktop / Overlay App (Rust Tauri / Electron)',
    stack: {
      language: 'Rust & TypeScript (or C# / Python)',
      frontend: 'React / Vite or Native Window Overlay',
      backend: 'Tauri Core / Electron Main IPC',
      database: 'Local SQLite / JSON Config Store',
      styling: 'Frameless / Native CSS',
      testing: 'Cargo Test + Vitest',
    },
  },
  {
    label: 'System / Linux / TrueNAS CLI Automation',
    stack: {
      language: 'Bash / Python 3 / Go',
      frontend: 'ANSI CLI / TUI Progress & Flags',
      backend: 'Systemd / Kernel / ZFS / OS Tooling',
      database: 'Stateless / Checksum & Backup Archives',
      styling: 'Structured CLI / JSON Output',
      testing: 'ShellCheck / Bats / Pytest',
    },
  },
  {
    label: 'ESP32 / Embedded Hardware Firmware (PlatformIO / C++)',
    stack: {
      language: 'C / C++ (ESP-IDF / Arduino)',
      frontend: 'Serial Console / Web-Serial / OLED HUD',
      backend: 'PlatformIO + I2C / SPI / UART / GPIO Protocols',
      database: 'EEPROM / NVS Flash Storage',
      styling: 'Embedded WebUI / Serial Telemetry',
      testing: 'PlatformIO Unity / Hardware Bus Verifier',
    },
  },
  {
    label: 'Python FastAPI + React + Postgres',
    stack: {
      language: 'Python 3.12 & TypeScript',
      frontend: 'React + Vite',
      backend: 'FastAPI + Pydantic v2',
      database: 'PostgreSQL + SQLAlchemy / Alembic',
      styling: 'Tailwind CSS',
      testing: 'Pytest + Vitest',
    },
  },
  {
    label: 'Go Microservice / CLI',
    stack: {
      language: 'Go 1.23',
      frontend: 'CLI or Web Dashboard',
      backend: 'Go net/http / Chi / gRPC',
      database: 'PostgreSQL / SQLite (sqlc)',
      styling: 'N/A',
      testing: 'go test + table-driven suites',
    },
  },
];

function previewBlueprint(input: {
  name: string;
  appType: ProjectAppType;
  description: string;
  techStack: ProjectTechStack;
  architectureNotes: string;
  referenceDocs: string;
}): string {
  const appLabel = APP_TYPES.find((a) => a.id === input.appType)?.label ?? 'Custom Software Project';
  const stackLines = [
    input.techStack.language && `- **Primary Language:** ${input.techStack.language}`,
    input.techStack.frontend && `- **Frontend Framework:** ${input.techStack.frontend}`,
    input.techStack.backend && `- **Backend / Runtime:** ${input.techStack.backend}`,
    input.techStack.database && `- **Database & ORM:** ${input.techStack.database}`,
    input.techStack.styling && `- **UI & Styling:** ${input.techStack.styling}`,
    input.techStack.testing && `- **Testing & QA:** ${input.techStack.testing}`,
  ]
    .filter(Boolean)
    .join('\n');

  return `# ${input.name || 'Untitled Project'} — Project Blueprint (\`PROJECT.md\`)

> **Application Type:** ${appLabel}
> **Managed By:** Emberline AI Coding Factory

## 1. Product Vision & Overview
${input.description.trim() || `${input.name || 'This project'} is a ${appLabel.toLowerCase()} built with the Emberline AI Coding Factory.`}

## 2. Technology Stack
${stackLines || '- Tech stack to be finalized with the System Architect agent.'}

## 3. Architecture & Engineering Standards
${input.architectureNotes.trim() || '- Keep module boundaries explicit.\n- Validate external inputs at boundaries.\n- Include automated tests with every feature.'}

## 4. Reference Specifications & Context
${input.referenceDocs.trim() || '- No external reference docs attached yet.'}
`;
}

export function ProjectWizardModal({
  open,
  runnerDown,
  onClose,
  onCreated,
}: {
  open: boolean;
  runnerDown?: boolean;
  onClose: () => void;
  onCreated: (res: CreateProjectResponse) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<'wizard' | 'manual'>('wizard');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [appType, setAppType] = useState<ProjectAppType>('fullstack');
  const [description, setDescription] = useState('');
  const [techStack, setTechStack] = useState<ProjectTechStack>(() => ({
    language: 'TypeScript (Node 22)',
    frontend: 'React 19 + Vite',
    backend: 'Fastify + Zod',
    database: 'SQLite + Drizzle ORM',
    styling: 'Modern CSS / Design Tokens',
    testing: 'Vitest + Playwright',
  }));
  const [architectureNotes, setArchitectureNotes] = useState(
    '- Organize code into clear domain modules.\n- Validate all API inputs with schemas.\n- Every feature must include automated tests.',
  );
  const [referenceDocs, setReferenceDocs] = useState('');
  const [initGit, setInitGit] = useState(true);
  const [seedStarterTickets, setSeedStarterTickets] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const blueprintPreview = useMemo(
    () =>
      previewBlueprint({
        name,
        appType,
        description,
        techStack,
        architectureNotes,
        referenceDocs,
      }),
    [name, appType, description, techStack, architectureNotes, referenceDocs],
  );

  if (!open) return null;

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const snippets: string[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      snippets.push(`### Reference File: ${file.name}\n\n${text.slice(0, 12_000)}`);
    }
    setReferenceDocs((prev) => (prev.trim() ? `${prev.trim()}\n\n${snippets.join('\n\n')}` : snippets.join('\n\n')));
    e.target.value = '';
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const payload =
        mode === 'manual'
          ? {
              name: name.trim(),
              mode: 'manual' as const,
              repoUrl: repoUrl.trim() || undefined,
              defaultBranch: defaultBranch.trim() || 'main',
              description: description.trim(),
              initGit,
              seedStarterTickets,
            }
          : {
              name: name.trim(),
              mode: 'wizard' as const,
              defaultBranch: defaultBranch.trim() || 'main',
              appType,
              description: description.trim(),
              techStack,
              architectureNotes: architectureNotes.trim(),
              referenceDocs: referenceDocs.trim(),
              initGit,
              seedStarterTickets,
            };
      const res = await api<CreateProjectResponse>('/api/projects', 'POST', payload);
      await onCreated(res);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <p className="eyebrow">AI Coding Factory · Workspace Setup</p>
            <h2 id="wizard-title" style={{ margin: 0, fontSize: '1.05rem' }}>
              Create New Project
            </h2>
          </div>
          <div className="segmented" role="tablist" aria-label="Creation mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'wizard'}
              className={mode === 'wizard' ? 'active' : ''}
              onClick={() => setMode('wizard')}
            >
              Guided Factory Wizard
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'manual'}
              className={mode === 'manual' ? 'active' : ''}
              onClick={() => setMode('manual')}
            >
              Manual / Git Clone
            </button>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {mode === 'manual' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p className="muted small">
                Start with an empty workspace directory or clone an existing Git repository directly into the runner.
              </p>
              <label className="drawer-label" htmlFor="manual-project-name">
                Project Name
              </label>
              <input
                id="manual-project-name"
                className="input"
                placeholder="e.g. acme-billing-api"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />

              <label className="drawer-label" htmlFor="manual-project-repo">
                Git Repository URL (optional — leave empty for a blank local project)
              </label>
              <input
                id="manual-project-repo"
                className="input"
                placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
              />

              <div className="drawer-row">
                <div style={{ flex: 1 }}>
                  <label className="drawer-label" htmlFor="manual-default-branch">
                    Default Branch
                  </label>
                  <input
                    id="manual-default-branch"
                    className="input"
                    value={defaultBranch}
                    onChange={(e) => setDefaultBranch(e.target.value)}
                  />
                </div>
              </div>

              {!repoUrl.trim() && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={initGit}
                      onChange={(e) => setInitGit(e.target.checked)}
                    />
                    <span className="small">
                      Initialize local Git repository (<code className="mono">git init</code>) so agent worktrees work immediately
                    </span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={seedStarterTickets}
                      onChange={(e) => setSeedStarterTickets(e.target.checked)}
                    />
                    <span className="small">
                      Seed 4 AI Factory starter tickets (PO → Architect → Coder → QA)
                    </span>
                  </label>
                </div>
              )}

              <footer className="drawer-foot" style={{ marginTop: '8px' }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  id="wizard-submit-manual"
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !name.trim() || Boolean(runnerDown && repoUrl.trim())}
                >
                  {busy ? 'Creating…' : repoUrl.trim() ? 'Clone & Create Project' : 'Create Blank Project'}
                </button>
              </footer>
            </div>
          ) : (
            <>
              <div className="segmented" aria-label="Wizard steps">
                <button
                  type="button"
                  className={step === 1 ? 'active' : ''}
                  onClick={() => setStep(1)}
                >
                  1. Vision & App Type
                </button>
                <button
                  type="button"
                  className={step === 2 ? 'active' : ''}
                  onClick={() => setStep(2)}
                >
                  2. Tech Stack
                </button>
                <button
                  type="button"
                  className={step === 3 ? 'active' : ''}
                  onClick={() => setStep(3)}
                >
                  3. Structure & Docs
                </button>
                <button
                  type="button"
                  className={step === 4 ? 'active' : ''}
                  onClick={() => setStep(4)}
                >
                  4. PROJECT.md & Launch
                </button>
              </div>

              {step === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <label className="drawer-label" htmlFor="wizard-project-name">
                    Project Name
                  </label>
                  <input
                    id="wizard-project-name"
                    className="input"
                    placeholder="e.g. pulse-analytics"
                    required
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />

                  <label className="drawer-label">Application Type</label>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                      gap: '8px',
                    }}
                  >
                    {APP_TYPES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`card${appType === t.id ? ' card-live' : ''}`}
                        style={{
                          textAlign: 'left',
                          cursor: 'pointer',
                          borderColor: appType === t.id ? 'var(--accent)' : undefined,
                        }}
                        onClick={() => setAppType(t.id)}
                      >
                        <strong style={{ display: 'block', fontSize: '0.88rem' }}>{t.label}</strong>
                        <span className="muted small">{t.desc}</span>
                      </button>
                    ))}
                  </div>

                  <label className="drawer-label" htmlFor="wizard-description">
                    Product Vision, Core Features & Target Users
                  </label>
                  <textarea
                    id="wizard-description"
                    className="input"
                    rows={4}
                    placeholder="Describe what you want the AI Coding Factory to build, key user workflows, and business goals…"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              )}

              {step === 2 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <span className="drawer-label" style={{ display: 'block', marginBottom: '6px' }}>
                      Quick Presets (1-click fill)
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {STACK_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          className="chip-btn"
                          onClick={() => setTechStack(preset.stack)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                      gap: '10px',
                    }}
                  >
                    <div>
                      <label className="drawer-label">Language & Runtime</label>
                      <input
                        className="input"
                        value={techStack.language}
                        onChange={(e) => setTechStack({ ...techStack, language: e.target.value })}
                        placeholder="e.g. TypeScript, Python 3.12, Go"
                      />
                    </div>
                    <div>
                      <label className="drawer-label">Frontend Framework</label>
                      <input
                        className="input"
                        value={techStack.frontend}
                        onChange={(e) => setTechStack({ ...techStack, frontend: e.target.value })}
                        placeholder="e.g. React 19 + Vite, Next.js"
                      />
                    </div>
                    <div>
                      <label className="drawer-label">Backend / API</label>
                      <input
                        className="input"
                        value={techStack.backend}
                        onChange={(e) => setTechStack({ ...techStack, backend: e.target.value })}
                        placeholder="e.g. Fastify, FastAPI, Express"
                      />
                    </div>
                    <div>
                      <label className="drawer-label">Database & ORM</label>
                      <input
                        className="input"
                        value={techStack.database}
                        onChange={(e) => setTechStack({ ...techStack, database: e.target.value })}
                        placeholder="e.g. PostgreSQL + Drizzle, SQLite"
                      />
                    </div>
                    <div>
                      <label className="drawer-label">UI & Styling</label>
                      <input
                        className="input"
                        value={techStack.styling}
                        onChange={(e) => setTechStack({ ...techStack, styling: e.target.value })}
                        placeholder="e.g. Tailwind CSS, CSS Modules"
                      />
                    </div>
                    <div>
                      <label className="drawer-label">Testing Suite</label>
                      <input
                        className="input"
                        value={techStack.testing}
                        onChange={(e) => setTechStack({ ...techStack, testing: e.target.value })}
                        placeholder="e.g. Vitest + Playwright"
                      />
                    </div>
                  </div>
                </div>
              )}

              {step === 3 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <label className="drawer-label" htmlFor="wizard-arch-notes">
                    Project Structure, Architecture Conventions & Coding Rules
                  </label>
                  <textarea
                    id="wizard-arch-notes"
                    className="input"
                    rows={4}
                    placeholder="Folder layout, monorepo structure, API conventions, coding standards…"
                    value={architectureNotes}
                    onChange={(e) => setArchitectureNotes(e.target.value)}
                  />

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <label className="drawer-label" htmlFor="wizard-ref-docs" style={{ margin: 0 }}>
                      Reference Docs, Example Projects or Specs
                    </label>
                    <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                      Attach .md / .txt / .json file
                      <input
                        type="file"
                        accept=".md,.txt,.json,.yaml,.yml"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => void handleFileUpload(e)}
                      />
                    </label>
                  </div>
                  <textarea
                    id="wizard-ref-docs"
                    className="input"
                    rows={5}
                    placeholder="Paste reference documentation, sample API schemas, example repos, or domain requirements…"
                    value={referenceDocs}
                    onChange={(e) => setReferenceDocs(e.target.value)}
                  />
                </div>
              )}

              {step === 4 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <p className="muted small">
                    Emberline will generate <code className="mono">PROJECT.md</code> and <code className="mono">CLAUDE.md</code> in your new workspace so every agent persona starts with full context.
                  </p>
                  <pre
                    className="mono"
                    style={{
                      maxHeight: '220px',
                      overflow: 'auto',
                      padding: '12px',
                      borderRadius: '8px',
                      background: 'var(--bg-elevated, rgba(0,0,0,0.25))',
                      border: '1px solid var(--border)',
                      fontSize: '0.78rem',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {blueprintPreview}
                  </pre>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={initGit}
                      onChange={(e) => setInitGit(e.target.checked)}
                    />
                    <span className="small">
                      Initialize Git repository (<code className="mono">git init</code>) and commit <code className="mono">PROJECT.md</code> so isolated agent worktrees work immediately
                    </span>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={seedStarterTickets}
                      onChange={(e) => setSeedStarterTickets(e.target.checked)}
                    />
                    <span className="small">
                      Auto-seed 4 AI Factory starter tickets (<strong>Product Owner</strong> → <strong>Architect</strong> → <strong>Coder</strong> → <strong>QA</strong>)
                    </span>
                  </label>
                </div>
              )}

              <footer className="drawer-foot">
                <div className="actions">
                  {step > 1 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4) : s))}
                    >
                      ← Back
                    </button>
                  )}
                </div>
                <div className="actions">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
                    Cancel
                  </button>
                  {step < 4 ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={step === 1 && !name.trim()}
                      onClick={() => setStep((s) => (s < 4 ? ((s + 1) as 1 | 2 | 3 | 4) : s))}
                    >
                      Next step →
                    </button>
                  ) : (
                    <button
                      id="wizard-submit"
                      type="submit"
                      className="btn btn-sm btn-primary"
                      disabled={busy || !name.trim()}
                    >
                      {busy ? 'Generating Factory…' : 'Create Project & Generate PROJECT.md'}
                    </button>
                  )}
                </div>
              </footer>
            </>
          )}
          {error && <p className="form-error">{error}</p>}
        </form>
      </aside>
    </div>
  );
}
