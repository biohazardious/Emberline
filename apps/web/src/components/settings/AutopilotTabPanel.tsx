import type { ThemeMode } from '@emberline/protocol';
import { FlaskConical, Lock, Moon, Save, Scale, Shield, Sun } from 'lucide-react';
import type { FormEvent } from 'react';
import { clampQuotaGb } from '../../buildOutputs';
import { clampParallel } from './providerRoutingHelpers';

export interface AutopilotTabPanelProps {
  theme: 'dark' | 'light';
  onChangeTheme: (theme: 'dark' | 'light') => void;
  setThemePref: (theme: ThemeMode) => void;
  autoPickupReady: boolean;
  setAutoPickupReady: (value: boolean) => void;
  autoPickupBacklog: boolean;
  setAutoPickupBacklog: (value: boolean) => void;
  selfHealingBuildGate: boolean;
  setSelfHealingBuildGate: (value: boolean) => void;
  antiSlopGate: boolean;
  setAntiSlopGate: (value: boolean) => void;
  requireCompletionSignal: boolean;
  setRequireCompletionSignal: (value: boolean) => void;
  secretGuardGate: boolean;
  setSecretGuardGate: (value: boolean) => void;
  crossProviderCritic: boolean;
  setCrossProviderCritic: (value: boolean) => void;
  autoSyncToMain: boolean;
  setAutoSyncToMain: (value: boolean) => void;
  autoMoveToDone: boolean;
  setAutoMoveToDone: (value: boolean) => void;
  maxAutoRunsPerDay: number;
  setMaxAutoRunsPerDay: (value: number) => void;
  maxParallelTickets: string;
  setMaxParallelTickets: (value: string) => void;
  buildOutputsQuotaGb: string;
  setBuildOutputsQuotaGb: (value: string) => void;
  maxTicketDepth: number;
  setMaxTicketDepth: (value: number) => void;
  saving: boolean;
  onSave: (e: FormEvent) => void;
}

export function AutopilotTabPanel({
  theme,
  onChangeTheme,
  setThemePref,
  autoPickupReady,
  setAutoPickupReady,
  autoPickupBacklog,
  setAutoPickupBacklog,
  selfHealingBuildGate,
  setSelfHealingBuildGate,
  antiSlopGate,
  setAntiSlopGate,
  requireCompletionSignal,
  setRequireCompletionSignal,
  secretGuardGate,
  setSecretGuardGate,
  crossProviderCritic,
  setCrossProviderCritic,
  autoSyncToMain,
  setAutoSyncToMain,
  autoMoveToDone,
  setAutoMoveToDone,
  maxAutoRunsPerDay,
  setMaxAutoRunsPerDay,
  maxParallelTickets,
  setMaxParallelTickets,
  buildOutputsQuotaGb,
  setBuildOutputsQuotaGb,
  maxTicketDepth,
  setMaxTicketDepth,
  saving,
  onSave,
}: AutopilotTabPanelProps) {
  return (
    <form
      onSubmit={onSave}
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
            <Moon className="icon" aria-hidden /> Dark Workbench
          </button>
          <button
            type="button"
            className={`btn ${theme === 'light' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => {
              setThemePref('light');
              onChangeTheme('light');
            }}
          >
            <Sun className="icon" aria-hidden /> Light Workbench
          </button>
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <span className="eyebrow">Autonomous Pipeline</span>
          <h3 style={{ margin: '4px 0 4px' }}>Backlog &amp; Ready Auto-Pickup + Self-Healing</h3>
          <p className="muted small">
            Configure how the AI Coding Factory chains specialist tickets, verifies builds, and updates the
            live workspace.
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
              Automatically start the highest-priority ticket in the <code>Ready</code> column as soon as the
              previous specialist finishes.
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
              When the <code>Ready</code> column is empty during an active pipeline run, automatically pull
              the next highest-priority ticket from <code>Backlog</code>.
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
            <strong>
              <FlaskConical className="icon" aria-hidden /> Self-Healing Build, Lint &amp; Unit Test Gate
              (Auto-Verify &amp; Auto-Fix)
            </strong>
            <div className="muted small">
              When a specialist finishes a run, automatically run the project&apos;s <code>build</code>/
              <code>typecheck</code>, <code>lint</code>, and <code>test</code> suites (`CI=true`). If any
              check fails, resume the agent with the exact compiler/linter/test failure output to self-heal
              before advancing. It also asks the agent once to fix an invalid .emberline/worktree.yml or to
              add an Auto Bootstrap&apos;s missing commands; when it is off, such runs wait for you in Review.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={antiSlopGate}
            onChange={(e) => setAntiSlopGate(e.target.checked)}
            style={{ marginTop: '3px' }}
          />
          <div>
            <strong>
              <Shield className="icon" aria-hidden /> Anti-AI-Slop &amp; Anti-Vibe-Coding Gate (Deterministic
              Diff Audit &amp; Auto-Clean)
            </strong>
            <div className="muted small">
              Automatically scan every completed worktree diff for untyped casts, compiler or linter
              suppression directives, unfinished placeholder stubs, skipped tests, leftover debug statements,
              and generic AI gradient clichés. If blocked, auto-resume the agent once to clean its own code.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={requireCompletionSignal}
            onChange={(e) => setRequireCompletionSignal(e.target.checked)}
            style={{ marginTop: '3px' }}
          />
          <div>
            <strong>Require agents to confirm completion</strong>
            <div className="muted small">
              Factory tickets advance only after the agent calls <code>ticket_complete</code>; otherwise it is
              asked once, then the ticket waits for you.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={secretGuardGate}
            onChange={(e) => setSecretGuardGate(e.target.checked)}
            style={{ marginTop: '3px' }}
          />
          <div>
            <strong>
              <Lock className="icon" aria-hidden /> Pre-Commit Secret &amp; Credential Guard (Auto-Block &amp;
              Redact Leaked Keys)
            </strong>
            <div className="muted small">
              Inspects diffs before commit and before <code>main</code> workspace sync for hardcoded API keys
              (<code>sk-...</code>, <code>AIza...</code>, <code>ghp_...</code>, <code>AKIA...</code>), private
              keys (<code>.pem</code>/<code>.key</code>), and tracked <code>.env</code> files. Blocks merging
              into <code>main</code> and instructs the agent to move secrets to <code>process.env</code> +{' '}
              <code>.env.example</code>.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={crossProviderCritic}
            onChange={(e) => setCrossProviderCritic(e.target.checked)}
            style={{ marginTop: '3px' }}
          />
          <div>
            <strong>
              <Scale className="icon" aria-hidden /> Cross-Provider AI Critic (Rival Provider Code Review)
            </strong>
            <div className="muted small">
              When multiple providers are active (e.g. Claude + Google Antigravity), automatically have a
              rival provider audit the completed diff against the ticket specification before moving to{' '}
              <code>Done</code>.
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
              Merge each completed specialist&apos;s branch into <code>/workspaces/&lt;slug&gt;</code> with
              git so subsequent specialists and the Live Demo stay up to date. Conflicts keep the ticket in
              Review; untracked files such as <code>.env</code> are never touched.
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
              Move factory pipeline tickets directly to the <code>Done</code> column once their build and sync
              succeed.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input
            type="number"
            className="input mono"
            min={0}
            max={1000}
            value={maxAutoRunsPerDay}
            onChange={(e) => setMaxAutoRunsPerDay(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
            style={{ width: '90px' }}
          />
          <div>
            <strong>Daily run budget per project</strong>
            <div className="muted small">
              Auto-dispatch stops starting new runs for a project once this many runs started in the last 24
              hours (0 = unlimited). Manual starts are not limited.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input
            type="number"
            className="input mono"
            min={1}
            max={4}
            value={maxParallelTickets}
            onChange={(e) => setMaxParallelTickets(e.target.value)}
            onBlur={() => setMaxParallelTickets(String(clampParallel(maxParallelTickets)))}
            style={{ width: '90px' }}
          />
          <div>
            <strong>Parallel tickets per project</strong>
            <div className="muted small">
              How many unblocked tickets of one project the factory works on at the same time (1-4). Tickets
              that wait for a dependency never start early.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input
            type="number"
            className="input mono"
            min={0.5}
            max={1000}
            step="any"
            value={buildOutputsQuotaGb}
            onChange={(e) => setBuildOutputsQuotaGb(e.target.value)}
            onBlur={() => setBuildOutputsQuotaGb(String(clampQuotaGb(buildOutputsQuotaGb)))}
            style={{ width: '90px' }}
          />
          <div>
            <strong>Build outputs archive per project (GB)</strong>
            <div className="muted small">
              Archived APKs, installers and firmware images are kept per project, on the workspaces volume, up
              to this size (0.5-1000 GB). Beyond it the oldest unpinned outputs are deleted; pinned ones stay.
              A lower value applies as soon as you save. Nothing is copied while the volume has less than 1 GB
              free.
            </div>
          </div>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input
            type="number"
            className="input mono"
            min={1}
            max={10}
            value={maxTicketDepth}
            onChange={(e) => setMaxTicketDepth(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            style={{ width: '90px' }}
          />
          <div>
            <strong>Agent ticket depth limit</strong>
            <div className="muted small">
              How many generations of agent-created tickets may follow a ticket you created. Drafts beyond it
              are dropped and noted on the run.
            </div>
          </div>
        </label>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? (
            'Saving…'
          ) : (
            <>
              <Save className="icon" aria-hidden /> Save Auto-Pilot &amp; Theme Settings
            </>
          )}
        </button>
      </div>
    </form>
  );
}
