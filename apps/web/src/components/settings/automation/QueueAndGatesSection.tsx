import { SettingRow } from '../../ui/SettingRow';
import { Switch } from '../../ui/Switch';
import { type AutopilotDraft, clampParallel } from '../settingsMeta';

export function QueueAndGatesSection({
  theme,
  onChangeTheme,
  draft,
  onChangeDraft,
}: {
  theme: 'dark' | 'light';
  onChangeTheme: (theme: 'dark' | 'light') => void;
  draft: AutopilotDraft;
  onChangeDraft: (patch: Partial<AutopilotDraft>) => void;
}) {
  const queueOnCount = Number(draft.autoPickupReady) + Number(draft.autoPickupBacklog);
  const qualityOnCount =
    Number(draft.selfHealingBuildGate) +
    Number(draft.antiSlopGate) +
    Number(draft.secretGuardGate) +
    Number(draft.requireCompletionSignal) +
    Number(draft.crossProviderCritic);

  return (
    <>
      <section className="settings-group" aria-labelledby="automation-appearance-heading">
        <header className="settings-group-head">
          <h2 id="automation-appearance-heading">Appearance</h2>
        </header>
        <div className="settings-group-rows">
          <SettingRow
            label="Theme"
            summary="Choose the dark or light workbench palette."
            control={
              <div className="segmented" role="radiogroup" aria-label="Theme">
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'dark'}
                  className={theme === 'dark' ? 'active' : ''}
                  onClick={() => {
                    onChangeDraft({ themePref: 'dark' });
                    onChangeTheme('dark');
                  }}
                >
                  Dark
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'light'}
                  className={theme === 'light' ? 'active' : ''}
                  onClick={() => {
                    onChangeDraft({ themePref: 'light' });
                    onChangeTheme('light');
                  }}
                >
                  Light
                </button>
              </div>
            }
          />
        </div>
      </section>

      <section className="settings-group" aria-labelledby="automation-queue-heading">
        <header className="settings-group-head">
          <h2 id="automation-queue-heading">Queue</h2>
          <span className="badge mono">{queueOnCount} of 2 on</span>
        </header>
        <div className="settings-group-rows">
          <SettingRow
            label="Start ready tickets"
            summary="Starts the highest-priority Ready ticket when the previous specialist finishes."
            details="Dispatches the next unblocked ticket in the Ready column as soon as a project slot frees up."
            control={
              <Switch
                checked={draft.autoPickupReady}
                onChange={(autoPickupReady) => onChangeDraft({ autoPickupReady })}
                ariaLabel="Start ready tickets"
              />
            }
          />

          <SettingRow
            label="Pull from backlog"
            summary="Pulls the next highest-priority ticket from Backlog when Ready is empty."
            details="Applies during an active pipeline run so work continues when the Ready column runs out."
            control={
              <Switch
                checked={draft.autoPickupBacklog}
                onChange={(autoPickupBacklog) => onChangeDraft({ autoPickupBacklog })}
                ariaLabel="Pull from backlog"
              />
            }
          />

          <SettingRow
            label="Parallel tickets per project"
            htmlFor="setting-parallel-tickets"
            summary="How many unblocked tickets of one project run at the same time."
            details="Clamped between 1 and 4 on blur. Tickets waiting for a dependency never start early."
            control={
              <input
                id="setting-parallel-tickets"
                type="number"
                className="input mono settings-number-input"
                min={1}
                max={4}
                value={draft.maxParallelTickets}
                onChange={(e) => onChangeDraft({ maxParallelTickets: e.target.value })}
                onBlur={() =>
                  onChangeDraft({ maxParallelTickets: String(clampParallel(draft.maxParallelTickets)) })
                }
              />
            }
          />

          <SettingRow
            label="Daily run budget per project"
            htmlFor="setting-daily-budget"
            summary="Stops auto-dispatch once this many runs started in the last 24 hours."
            details="Clamped between 0 and 1000 (0 = unlimited). Manual starts are not limited by the budget."
            control={
              <input
                id="setting-daily-budget"
                type="number"
                className="input mono settings-number-input"
                min={0}
                max={1000}
                value={draft.maxAutoRunsPerDay}
                onChange={(e) =>
                  onChangeDraft({
                    maxAutoRunsPerDay: Math.max(0, Math.min(1000, Number(e.target.value) || 0)),
                  })
                }
              />
            }
          />

          <SettingRow
            label="Agent ticket depth"
            htmlFor="setting-ticket-depth"
            summary="Generations of agent-created tickets allowed after a human ticket."
            details="Clamped between 1 and 10. Drafts beyond this depth are dropped and noted on the run."
            control={
              <input
                id="setting-ticket-depth"
                type="number"
                className="input mono settings-number-input"
                min={1}
                max={10}
                value={draft.maxTicketDepth}
                onChange={(e) =>
                  onChangeDraft({
                    maxTicketDepth: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                  })
                }
              />
            }
          />
        </div>
      </section>

      <section className="settings-group" aria-labelledby="automation-quality-heading">
        <header className="settings-group-head">
          <h2 id="automation-quality-heading">Quality gates</h2>
          <span className="badge mono">{qualityOnCount} of 5 on</span>
        </header>
        <div className="settings-group-rows">
          <SettingRow
            label="Build, lint and test gate"
            summary="Runs build, lint and test checks after each run and resumes the agent on failure."
            details={
              <>
                Runs the project&apos;s <code>build</code>/<code>typecheck</code>, <code>lint</code> and{' '}
                <code>test</code> suites with <code>CI=true</code> and resumes the agent with compiler, linter
                or test output. Also asks the agent once to fix an invalid{' '}
                <code>.emberline/worktree.yml</code> or add missing Auto Bootstrap commands; when off, such
                runs wait for you in Review.
              </>
            }
            control={
              <Switch
                checked={draft.selfHealingBuildGate}
                onChange={(selfHealingBuildGate) => onChangeDraft({ selfHealingBuildGate })}
                ariaLabel="Build, lint and test gate"
              />
            }
          />

          <SettingRow
            label="Diff audit"
            summary="Scans completed diffs for code hygiene issues and resumes the agent once to clean them."
            details={
              <>
                Scans diffs for type evasion (<code>: any</code>, <code>as any</code>, <code>@ts-ignore</code>
                ), unfinished <code>TODO</code>/<code>FIXME</code> stubs, skipped tests, leftover{' '}
                <code>console.log</code>/<code>debugger</code>, and generic AI gradient clichés. Comments are
                scanned; text inside strings, template literals and JSX is not scanned.
              </>
            }
            control={
              <Switch
                checked={draft.antiSlopGate}
                onChange={(antiSlopGate) => onChangeDraft({ antiSlopGate })}
                ariaLabel="Diff audit"
              />
            }
          />

          <SettingRow
            label="Secret guard"
            summary="Blocks commits and merges when diffs contain leaked keys or tracked .env files."
            details={
              <>
                Inspects diffs before commit and before <code>main</code> sync for hardcoded API keys (
                <code>sk-...</code>, <code>AIza...</code>, <code>ghp_...</code>, <code>AKIA...</code>),
                private keys (<code>.pem</code>/<code>.key</code>) and tracked <code>.env</code> files, and
                instructs the agent to move secrets to <code>process.env</code> and <code>.env.example</code>.
              </>
            }
            control={
              <Switch
                checked={draft.secretGuardGate}
                onChange={(secretGuardGate) => onChangeDraft({ secretGuardGate })}
                ariaLabel="Secret guard"
              />
            }
          />

          <SettingRow
            label="Require completion signal"
            summary="Advances factory tickets only after the agent calls ticket_complete."
            details={
              <>
                If the agent finishes without calling <code>ticket_complete</code>, it is asked once and then
                the ticket waits for you.
              </>
            }
            control={
              <Switch
                checked={draft.requireCompletionSignal}
                onChange={(requireCompletionSignal) => onChangeDraft({ requireCompletionSignal })}
                ariaLabel="Require completion signal"
              />
            }
          />

          <SettingRow
            label="Cross-provider review"
            summary="Has a rival active provider audit the completed diff before Done."
            details={
              <>
                When multiple providers are active (for example Claude and Antigravity), a second provider
                audits the completed diff against the ticket specification before moving to <code>Done</code>.
              </>
            }
            control={
              <Switch
                checked={draft.crossProviderCritic}
                onChange={(crossProviderCritic) => onChangeDraft({ crossProviderCritic })}
                ariaLabel="Cross-provider review"
              />
            }
          />
        </div>
      </section>
    </>
  );
}
