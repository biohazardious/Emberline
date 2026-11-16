import type { Project, ProjectSettingsResponse } from '@emberline/protocol';
import { useState } from 'react';
import { api, errorMessage } from '../../api';
import { useApi } from '../../hooks/useApi';
import { type GateChoice, gateChoices, gateUpdate } from '../../projectSettings';
import { Disclosure } from '../ui/Disclosure';
import { HelpHint } from '../ui/HelpHint';
import { SettingRow } from '../ui/SettingRow';
import { Switch } from '../ui/Switch';

/** Native radios styled as segments: one tab stop, arrow keys move and select. */
export function GateRadios({
  name,
  labelledBy,
  options,
  value,
  disabled,
  onChange,
}: {
  name: string;
  labelledBy: string;
  options: { value: GateChoice; label: string }[];
  value: GateChoice;
  disabled: boolean;
  onChange: (choice: GateChoice) => void;
}) {
  return (
    <div className="segmented segmented-radios" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((o) => (
        <label key={o.value} className={value === o.value ? 'active' : ''}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function ProjectGatesSection({ project }: { project: Project }) {
  const settings = useApi<ProjectSettingsResponse>(`/api/projects/${project.id}/settings`, 15_000);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (key: Parameters<typeof gateUpdate>[0], choice: GateChoice) => {
    setSaving(key);
    setError(null);
    try {
      await api(`/api/projects/${project.id}/settings`, 'PATCH', gateUpdate(key, choice));
      await settings.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const rows = settings.data ? gateChoices(settings.data) : [];

  return (
    <section className="project-settings-section" aria-labelledby="project-gates-title">
      <div className="project-settings-section-head">
        <div className="project-settings-section-title">
          <h3 id="project-gates-title" className="project-settings-section-title">
            Gates
          </h3>
          <HelpHint topic="project gates">
            Inherit follows the global setting, including later changes to it. Toggling a gate sets an
            explicit override for this project.
          </HelpHint>
        </div>
      </div>
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      {settings.error !== undefined && settings.data && (
        <p className="muted small" role="alert">
          Couldn&apos;t refresh the gate settings ({errorMessage(settings.error)}); showing the last values.
        </p>
      )}
      {settings.error !== undefined && !settings.data && (
        <p className="banner banner-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      )}
      {settings.data && (
        <>
          <div className="project-settings-rows">
            {rows.map((row) => (
              <SettingRow
                key={row.key}
                label={row.label}
                summary={row.hint}
                control={
                  <Switch
                    checked={settings.data!.effective[row.key]}
                    disabled={saving === row.key}
                    busy={saving === row.key}
                    ariaLabel={row.label}
                    onChange={(checked) => void choose(row.key, checked ? 'on' : 'off')}
                  />
                }
              />
            ))}
          </div>
          <Disclosure label="Gate inheritance">
            <ul className="gate-inheritance-list">
              {rows.map((row) => (
                <li key={row.key} className="gate-inheritance-row">
                  <span id={`gate-${row.key}`}>{row.label}</span>
                  <GateRadios
                    name={`gate-${row.key}`}
                    labelledBy={`gate-${row.key}`}
                    options={row.options}
                    value={row.choice}
                    disabled={saving === row.key}
                    onChange={(choice) => void choose(row.key, choice)}
                  />
                </li>
              ))}
            </ul>
          </Disclosure>
        </>
      )}
    </section>
  );
}
