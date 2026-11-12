import type { FactorySettings } from '@emberline/protocol';
import { FlaskConical, Lock, Moon, Save, Scale, Shield, Sun } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { clampQuotaGb } from '../../buildOutputs';
import { ico, SectionState } from '../SectionState';
import { type AutopilotDraft, clampParallel, ST_HR, ST_PANEL_PAD, ST_SAVE_ROW } from './settingsMeta';

function GateToggle({
  checked,
  onChange,
  title,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: '3px' }}
      />
      <div>
        <strong>{title}</strong>
        <div className="muted small">{children}</div>
      </div>
    </label>
  );
}

function NumberSetting({
  min,
  max,
  step,
  value,
  onChange,
  onBlur,
  title,
  children,
}: {
  min: number;
  max: number;
  step?: string;
  value: number | string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <input
        type="number"
        className="input mono"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        style={{ width: '90px' }}
      />
      <div>
        <strong>{title}</strong>
        <div className="muted small">{children}</div>
      </div>
    </label>
  );
}

export function AutopilotSection({
  settings,
  loading,
  loadError,
  onRetry,
  theme,
  onChangeTheme,
  draft,
  onChangeDraft,
  saving,
  onSave,
}: {
  settings: FactorySettings | undefined;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => Promise<void>;
  theme: 'dark' | 'light';
  onChangeTheme: (theme: 'dark' | 'light') => void;
  draft: AutopilotDraft;
  onChangeDraft: (patch: Partial<AutopilotDraft>) => void;
  saving: boolean;
  onSave: (e: FormEvent) => void;
}) {
  if (!settings) {
    return (
      <SectionState
        loading={loading}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading Auto-Pilot & Theme settings…"
        emptyText="No factory settings available yet."
        errorPrefix="Could not load factory settings"
        style={ST_PANEL_PAD}
      />
    );
  }

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
              onChangeDraft({ themePref: 'dark' });
              onChangeTheme('dark');
            }}
          >
            {ico(Moon)} Dark Workbench
          </button>
          <button
            type="button"
            className={`btn ${theme === 'light' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => {
              onChangeDraft({ themePref: 'light' });
              onChangeTheme('light');
            }}
          >
            {ico(Sun)} Light Workbench
          </button>
        </div>
      </div>

      <hr style={ST_HR} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <span className="eyebrow">Autonomous Pipeline</span>
          <h3 style={{ margin: '4px 0 4px' }}>Backlog &amp; Ready Auto-Pickup + Self-Healing</h3>
          <p className="muted small">
            Configure how the AI Coding Factory chains specialist tickets, verifies builds, and updates the
            live workspace.
          </p>
        </div>

        <GateToggle
          checked={draft.autoPickupReady}
          onChange={(autoPickupReady) => onChangeDraft({ autoPickupReady })}
          title="Auto-Pickup Ready Queue"
        >
          Automatically start the highest-priority ticket in the <code>Ready</code> column as soon as the
          previous specialist finishes.
        </GateToggle>

        <GateToggle
          checked={draft.autoPickupBacklog}
          onChange={(autoPickupBacklog) => onChangeDraft({ autoPickupBacklog })}
          title="Auto-Pickup Backlog Queue (Continuous Factory Mode)"
        >
          When the <code>Ready</code> column is empty during an active pipeline run, automatically pull the
          next highest-priority ticket from <code>Backlog</code>.
        </GateToggle>

        <GateToggle
          checked={draft.selfHealingBuildGate}
          onChange={(selfHealingBuildGate) => onChangeDraft({ selfHealingBuildGate })}
          title={
            <>
              {ico(FlaskConical)} Self-Healing Build, Lint &amp; Unit Test Gate (Auto-Verify &amp; Auto-Fix)
            </>
          }
        >
          When a specialist finishes a run, automatically run the project&apos;s <code>build</code>/
          <code>typecheck</code>, <code>lint</code>, and <code>test</code> suites (`CI=true`). If any check
          fails, resume the agent with the exact compiler/linter/test failure output to self-heal before
          advancing. It also asks the agent once to fix an invalid .emberline/worktree.yml or to add an Auto
          Bootstrap&apos;s missing commands; when it is off, such runs wait for you in Review.
        </GateToggle>

        <GateToggle
          checked={draft.antiSlopGate}
          onChange={(antiSlopGate) => onChangeDraft({ antiSlopGate })}
          title={
            <>
              {ico(Shield)} Anti-AI-Slop &amp; Anti-Vibe-Coding Gate (Deterministic Diff Audit &amp;
              Auto-Clean)
            </>
          }
        >
          Automatically scan every completed worktree diff for untyped casts, compiler or linter suppression
          directives, unfinished placeholder stubs, skipped tests, leftover debug statements, and generic AI
          gradient clichés. If blocked, auto-resume the agent once to clean its own code.
        </GateToggle>

        <GateToggle
          checked={draft.requireCompletionSignal}
          onChange={(requireCompletionSignal) => onChangeDraft({ requireCompletionSignal })}
          title="Require agents to confirm completion"
        >
          Factory tickets advance only after the agent calls <code>ticket_complete</code>; otherwise it is
          asked once, then the ticket waits for you.
        </GateToggle>

        <GateToggle
          checked={draft.secretGuardGate}
          onChange={(secretGuardGate) => onChangeDraft({ secretGuardGate })}
          title={
            <>{ico(Lock)} Pre-Commit Secret &amp; Credential Guard (Auto-Block &amp; Redact Leaked Keys)</>
          }
        >
          Inspects diffs before commit and before <code>main</code> workspace sync for hardcoded API keys (
          <code>sk-...</code>, <code>AIza...</code>, <code>ghp_...</code>, <code>AKIA...</code>), private keys
          (<code>.pem</code>/<code>.key</code>), and tracked <code>.env</code> files. Blocks merging into{' '}
          <code>main</code> and instructs the agent to move secrets to <code>process.env</code> +{' '}
          <code>.env.example</code>.
        </GateToggle>

        <GateToggle
          checked={draft.crossProviderCritic}
          onChange={(crossProviderCritic) => onChangeDraft({ crossProviderCritic })}
          title={<>{ico(Scale)} Cross-Provider AI Critic (Rival Provider Code Review)</>}
        >
          When multiple providers are active (e.g. Claude + Google Antigravity), automatically have a rival
          provider audit the completed diff against the ticket specification before moving to{' '}
          <code>Done</code>.
        </GateToggle>

        <GateToggle
          checked={draft.autoSyncToMain}
          onChange={(autoSyncToMain) => onChangeDraft({ autoSyncToMain })}
          title="Auto-Sync Completed Worktrees into Main Host Workspace"
        >
          Merge each completed specialist&apos;s branch into <code>/workspaces/&lt;slug&gt;</code> with git so
          subsequent specialists and the Live Demo stay up to date. Conflicts keep the ticket in Review;
          untracked files such as <code>.env</code> are never touched.
        </GateToggle>

        <GateToggle
          checked={draft.autoMoveToDone}
          onChange={(autoMoveToDone) => onChangeDraft({ autoMoveToDone })}
          title="Auto-Move Verified Factory Tickets to Done"
        >
          Move factory pipeline tickets directly to the <code>Done</code> column once their build and sync
          succeed.
        </GateToggle>

        <NumberSetting
          min={0}
          max={1000}
          value={draft.maxAutoRunsPerDay}
          onChange={(v) => onChangeDraft({ maxAutoRunsPerDay: Math.max(0, Math.min(1000, Number(v) || 0)) })}
          title="Daily run budget per project"
        >
          Auto-dispatch stops starting new runs for a project once this many runs started in the last 24 hours
          (0 = unlimited). Manual starts are not limited.
        </NumberSetting>

        <NumberSetting
          min={1}
          max={4}
          value={draft.maxParallelTickets}
          onChange={(maxParallelTickets) => onChangeDraft({ maxParallelTickets })}
          onBlur={() =>
            onChangeDraft({ maxParallelTickets: String(clampParallel(draft.maxParallelTickets)) })
          }
          title="Parallel tickets per project"
        >
          How many unblocked tickets of one project the factory works on at the same time (1-4). Tickets that
          wait for a dependency never start early.
        </NumberSetting>

        <NumberSetting
          min={0.5}
          max={1000}
          step="any"
          value={draft.buildOutputsQuotaGb}
          onChange={(buildOutputsQuotaGb) => onChangeDraft({ buildOutputsQuotaGb })}
          onBlur={() =>
            onChangeDraft({ buildOutputsQuotaGb: String(clampQuotaGb(draft.buildOutputsQuotaGb)) })
          }
          title="Build outputs archive per project (GB)"
        >
          Archived APKs, installers and firmware images are kept per project, on the workspaces volume, up to
          this size (0.5-1000 GB). Beyond it the oldest unpinned outputs are deleted; pinned ones stay. A
          lower value applies as soon as you save. Nothing is copied while the volume has less than 1 GB free.
        </NumberSetting>

        <NumberSetting
          min={1}
          max={10}
          value={draft.maxTicketDepth}
          onChange={(v) => onChangeDraft({ maxTicketDepth: Math.max(1, Math.min(10, Number(v) || 1)) })}
          title="Agent ticket depth limit"
        >
          How many generations of agent-created tickets may follow a ticket you created. Drafts beyond it are
          dropped and noted on the run.
        </NumberSetting>
      </div>

      <div style={ST_SAVE_ROW}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : <>{ico(Save)} Save Auto-Pilot &amp; Theme Settings</>}
        </button>
      </div>
    </form>
  );
}
