import { clampQuotaGb } from '../../../buildOutputs';
import { SettingRow } from '../../ui/SettingRow';
import { Switch } from '../../ui/Switch';
import type { AutopilotDraft } from '../settingsMeta';

export function MergingAndCommitSection({
  draft,
  onChangeDraft,
}: {
  draft: AutopilotDraft;
  onChangeDraft: (patch: Partial<AutopilotDraft>) => void;
}) {
  const mergingOnCount =
    Number(draft.autoSyncToMain) +
    Number(draft.autoResolveAdditiveConflicts) +
    Number(draft.serializeOverlappingTickets) +
    Number(draft.autoMoveToDone);

  return (
    <>
      <section className="settings-group" aria-labelledby="automation-merging-heading">
        <header className="settings-group-head">
          <h2 id="automation-merging-heading">Merging</h2>
          <span className="badge mono">{mergingOnCount} of 4 on</span>
        </header>
        <div className="settings-group-rows">
          <SettingRow
            label="Merge finished work into main"
            summary="Merges each completed branch into the main workspace with git."
            details={
              <>
                Merges into <code>/workspaces/&lt;slug&gt;</code> so subsequent specialists and the Live Demo
                stay up to date. Conflicts keep the ticket in Review; untracked files such as{' '}
                <code>.env</code> are never touched.
              </>
            }
            control={
              <Switch
                checked={draft.autoSyncToMain}
                onChange={(autoSyncToMain) => onChangeDraft({ autoSyncToMain })}
                ariaLabel="Merge finished work into main"
              />
            }
          />

          <SettingRow
            label="Auto-resolve additive conflicts"
            summary="Merges both sides when main and the ticket branch only added lines at the same spot."
            details="Requires the build gate to pass after uniting the additive hunks before landing in main."
            control={
              <Switch
                checked={draft.autoResolveAdditiveConflicts}
                onChange={(autoResolveAdditiveConflicts) => onChangeDraft({ autoResolveAdditiveConflicts })}
                ariaLabel="Auto-resolve additive conflicts"
              />
            }
          />

          <SettingRow
            label="Serialize overlapping tickets"
            summary="Defers a Ready ticket whose target files overlap an active run."
            details="Waits until the active run with overlapping target or changed files merges or is held."
            control={
              <Switch
                checked={draft.serializeOverlappingTickets}
                onChange={(serializeOverlappingTickets) => onChangeDraft({ serializeOverlappingTickets })}
                ariaLabel="Serialize overlapping tickets"
              />
            }
          />

          <SettingRow
            label="Move verified tickets to Done"
            summary="Moves factory tickets to Done once their build and merge succeed."
            details={
              <>
                Advances verified pipeline tickets directly to the <code>Done</code> column without waiting in
                Review.
              </>
            }
            control={
              <Switch
                checked={draft.autoMoveToDone}
                onChange={(autoMoveToDone) => onChangeDraft({ autoMoveToDone })}
                ariaLabel="Move verified tickets to Done"
              />
            }
          />
        </div>
      </section>

      <section className="settings-group" aria-labelledby="automation-storage-heading">
        <header className="settings-group-head">
          <h2 id="automation-storage-heading">Storage</h2>
        </header>
        <div className="settings-group-rows">
          <SettingRow
            label="Build outputs archive (GB)"
            htmlFor="setting-build-outputs-quota"
            summary="Per-project archive size limit for build outputs on the workspaces volume."
            details="Clamped between 0.5 and 1000 GB on blur. Beyond this size, the oldest unpinned APKs, installers and firmware images are deleted while pinned outputs stay. A lower value applies on save; nothing is copied while the volume has less than 1 GB free."
            control={
              <input
                id="setting-build-outputs-quota"
                type="number"
                className="input mono settings-number-input"
                min={0.5}
                max={1000}
                step="any"
                value={draft.buildOutputsQuotaGb}
                onChange={(e) => onChangeDraft({ buildOutputsQuotaGb: e.target.value })}
                onBlur={() =>
                  onChangeDraft({ buildOutputsQuotaGb: String(clampQuotaGb(draft.buildOutputsQuotaGb)) })
                }
              />
            }
          />
        </div>
      </section>

      <section className="settings-group" aria-labelledby="automation-commit-heading">
        <header className="settings-group-head">
          <h2 id="automation-commit-heading">Commit identity</h2>
        </header>
        <p className="settings-group-help muted">
          Emberline merges and agent commits use this author unless overridden in Project settings.
        </p>
        <div className="settings-commit-grid">
          <label className="field">
            Name
            <input
              className="input"
              value={draft.commitName}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => onChangeDraft({ commitName: e.target.value })}
            />
          </label>
          <label className="field">
            Email
            <input
              className="input mono"
              type="email"
              value={draft.commitEmail}
              maxLength={254}
              autoComplete="off"
              onChange={(e) => onChangeDraft({ commitEmail: e.target.value })}
            />
          </label>
        </div>
      </section>
    </>
  );
}
