import {
  findOption,
  getProjectType,
  optionsForType,
  PROJECT_TYPES,
  type ProjectTypeId,
  STACK_DIMENSIONS,
  type StackChoice,
  type StackDimensionDef,
  VERSION_POLICIES,
} from '@emberline/protocol';
import { type Dispatch, useState } from 'react';
import { branchProblem, choiceHint, choiceProblem, isImport, type WizardAction, type WizardState } from './wizardLogic';

const OTHER = '__other';

function DimensionRow({
  dimension,
  type,
  value,
  edited,
  autoFocus,
  onChange,
}: {
  dimension: StackDimensionDef;
  type: ProjectTypeId;
  value: StackChoice | undefined;
  edited: boolean;
  autoFocus: boolean;
  onChange: (value: StackChoice) => void;
}) {
  const id = `wizard-dim-${dimension.id}`;
  const options = optionsForType(dimension.id, type);
  // A value from a draft or detection that is not in the list still shows as itself.
  const current = typeof value === 'string' && value !== 'none' && value !== 'agent' ? findOption(dimension.id, value) : undefined;
  if (current && !options.includes(current)) options.unshift(current);
  const selectValue = value === undefined ? 'agent' : typeof value === 'string' ? value : OTHER;
  const other = typeof value === 'object' ? value.other : null;
  const problem = other !== null && other.length > 0 ? choiceProblem(value) : null;
  const typeLabel = getProjectType(type)?.label ?? type;

  const hint = choiceHint(dimension.id, value);

  return (
    <div className="wizard-dim">
      <div className="wizard-dim-head">
        <label htmlFor={id} className="wizard-dim-label">
          {dimension.label}
          {edited && <span className="wizard-dim-edited">changed</span>}
        </label>
        <p id={`${id}-affects`} className="wizard-dim-affects">
          {dimension.affects}
        </p>
      </div>
      <div className="wizard-dim-control">
        <select
          id={id}
          className="input"
          value={selectValue}
          aria-describedby={hint ? `${id}-affects ${id}-hint` : `${id}-affects`}
          data-autofocus={autoFocus ? '' : undefined}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === OTHER ? { other: other ?? '' } : v);
          }}
        >
          {options.length > 0 && (
            <optgroup label={`For ${typeLabel}`}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Other choices">
            <option value="none">None (this project has no {dimension.label.toLowerCase()})</option>
            <option value="agent">Let the agent decide</option>
            <option value={OTHER}>Other…</option>
          </optgroup>
        </select>
        {hint && (
          <p id={`${id}-hint`} className="wizard-dim-hint">
            {hint}
          </p>
        )}
        {other !== null && (
          <>
            <input
              id={`${id}-other`}
              className="input"
              maxLength={200}
              autoComplete="off"
              placeholder="Describe it in one line"
              aria-label={`${dimension.label}: other`}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${id}-other-error` : undefined}
              value={other}
              onChange={(e) => onChange({ other: e.target.value })}
            />
            {problem && (
              <p id={`${id}-other-error`} className="form-error" role="alert">
                {problem}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function StepStack({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const type = state.appType ?? 'custom';
  const imported = isImport(state.source);
  const basic = STACK_DIMENSIONS.filter((d) => !d.advanced);
  const advanced = STACK_DIMENSIONS.filter((d) => d.advanced);
  const branch = branchProblem(state.defaultBranch);
  // Open on arrival when something inside needs attention; the person toggles it after that.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => Boolean(branch) || state.dirty.some((id) => advanced.some((d) => d.id === id)),
  );
  const row = (d: StackDimensionDef, autoFocus: boolean) => (
    <DimensionRow
      key={d.id}
      dimension={d}
      type={type}
      value={state.choices[d.id]}
      edited={state.dirty.includes(d.id)}
      autoFocus={autoFocus}
      onChange={(value) => dispatch({ type: 'choice', dimension: d.id, value })}
    />
  );

  return (
    <div className="wizard-step">
      {imported ? (
        <div className="field">
          <label htmlFor="wizard-import-type">Project type</label>
          <select
            id="wizard-import-type"
            className="input"
            value={type}
            data-autofocus=""
            onChange={(e) => dispatch({ type: 'appType', appType: e.target.value as ProjectTypeId })}
          >
            {PROJECT_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="muted small">Detected from the repository; the options below are scoped to it.</p>
        </div>
      ) : (
        <p className="muted small">
          Filled from the preset. What you change here stays when you pick another type or preset.
        </p>
      )}

      <div className="wizard-dims">{basic.map((d, i) => row(d, !imported && i === 0))}</div>

      <details className="wizard-details" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>Advanced</summary>
        <div className="wizard-dims">
          {advanced.map((d) => row(d, false))}
          {!imported && (
            <>
              <div className="wizard-dim">
                <label htmlFor="wizard-branch" className="wizard-dim-label">
                  Default branch
                </label>
                <div className="wizard-dim-control">
                  <input
                    id="wizard-branch"
                    className="input mono"
                    autoComplete="off"
                    spellCheck={false}
                    value={state.defaultBranch}
                    aria-invalid={branch ? true : undefined}
                    aria-describedby={branch ? 'wizard-branch-error' : undefined}
                    onChange={(e) => dispatch({ type: 'field', field: 'defaultBranch', value: e.target.value })}
                  />
                  {branch && (
                    <p id="wizard-branch-error" className="form-error" role="alert">
                      {branch}
                    </p>
                  )}
                </div>
              </div>
              <div className="wizard-dim">
                <label htmlFor="wizard-version-policy" className="wizard-dim-label">
                  Version policy
                </label>
                <div className="wizard-dim-control">
                  <select
                    id="wizard-version-policy"
                    className="input"
                    value={state.versionPolicy}
                    aria-describedby="wizard-version-policy-hint"
                    onChange={(e) => dispatch({ type: 'field', field: 'versionPolicy', value: e.target.value })}
                  >
                    {VERSION_POLICIES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <p id="wizard-version-policy-hint" className="muted small">
                    {VERSION_POLICIES.find((p) => p.id === state.versionPolicy)?.hint}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
