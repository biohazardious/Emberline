import { PROJECT_TYPES, presetsForType } from '@emberline/protocol';
import {
  Bot,
  Building,
  Cpu,
  FileText,
  Gamepad2,
  Globe,
  Layers,
  type LucideIcon,
  Package,
  Paperclip,
  Smartphone,
  Terminal,
  Zap,
} from 'lucide-react';
import { type ChangeEvent, type Dispatch, useState } from 'react';
import { errorMessage } from '../../api';
import { nameProblem, type WizardAction, type WizardState } from './wizardLogic';

const ICONS: Record<string, LucideIcon> = { Bot, Building, Cpu, FileText, Gamepad2, Globe, Layers, Package, Smartphone, Terminal, Zap };

/** Shared by the type step and the import repository step. */
export function NameField({
  state,
  dispatch,
  autoFocus,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  autoFocus?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const local = touched ? nameProblem(state.name) : null;
  const problem = state.nameError ?? local;
  return (
    <div className="field">
      <label htmlFor="wizard-name">Project name</label>
      <input
        id="wizard-name"
        className="input"
        maxLength={80}
        autoComplete="off"
        value={state.name}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? 'wizard-name-error' : undefined}
        data-autofocus={autoFocus ? '' : undefined}
        onBlur={() => setTouched(true)}
        onChange={(e) => dispatch({ type: 'field', field: 'name', value: e.target.value })}
      />
      {problem && (
        <p id="wizard-name-error" className="form-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

const REFERENCE_DOCS_MAX = 40_000;

export function StepType({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const presets = state.appType ? presetsForType(state.appType) : [];
  const [fileError, setFileError] = useState<string | null>(null);

  const attach = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    setFileError(null);
    try {
      const parts = await Promise.all(files.map(async (f) => `### Reference file: ${f.name}\n\n${(await f.text()).slice(0, 12_000)}`));
      const joined = [state.referenceDocs.trim(), ...parts].filter(Boolean).join('\n\n');
      if (joined.length > REFERENCE_DOCS_MAX) setFileError(`Reference docs are limited to ${REFERENCE_DOCS_MAX.toLocaleString()} characters; the end was cut.`);
      dispatch({ type: 'field', field: 'referenceDocs', value: joined.slice(0, REFERENCE_DOCS_MAX) });
    } catch (err) {
      setFileError(`Couldn't read the file: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="wizard-step">
      <NameField state={state} dispatch={dispatch} autoFocus={!state.name} />

      <fieldset className="wizard-fieldset">
        <legend className="wizard-legend">Project type</legend>
        <div className="wizard-cards wizard-cards-3">
          {PROJECT_TYPES.map((t, i) => {
            const Icon = ICONS[t.icon] ?? Layers;
            const checked = state.appType === t.id;
            return (
              <label key={t.id} className="wizard-card">
                <input
                  type="radio"
                  name="wizard-type"
                  value={t.id}
                  checked={checked}
                  data-autofocus={state.name && (checked || (!state.appType && i === 0)) ? '' : undefined}
                  onChange={() => dispatch({ type: 'appType', appType: t.id })}
                />
                <span className="wizard-card-title">
                  <Icon className="icon" aria-hidden />
                  {t.label}
                </span>
                <span className="wizard-card-hint">{t.description}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {state.appType && (
        <fieldset className="wizard-fieldset">
          <legend className="wizard-legend">Preset</legend>
          <div className="wizard-cards wizard-cards-2">
            {presets.map((p) => (
              <label key={p.id} className="wizard-card">
                <input
                  type="radio"
                  name="wizard-preset"
                  value={p.id}
                  checked={state.presetId === p.id}
                  onChange={() => dispatch({ type: 'preset', presetId: p.id })}
                />
                <span className="wizard-card-title">{p.label}</span>
                <span className="wizard-card-hint">{p.description}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="field">
        <label htmlFor="wizard-vision">Vision</label>
        <textarea
          id="wizard-vision"
          className="input wizard-textarea"
          rows={4}
          maxLength={4000}
          aria-describedby="wizard-vision-hint"
          value={state.vision}
          onChange={(e) => dispatch({ type: 'field', field: 'vision', value: e.target.value })}
        />
        <p id="wizard-vision-hint" className="muted small">
          What the product does and for whom. The product owner turns it into the first tickets.
        </p>
      </div>

      <details className="wizard-details">
        <summary>Reference docs (optional)</summary>
        <div className="field">
          <label htmlFor="wizard-ref-docs">Reference material for the agents</label>
          <textarea
            id="wizard-ref-docs"
            className="input wizard-textarea"
            rows={5}
            maxLength={REFERENCE_DOCS_MAX}
            value={state.referenceDocs}
            onChange={(e) => dispatch({ type: 'field', field: 'referenceDocs', value: e.target.value })}
          />
          <div className="actions">
            <label className="btn btn-sm wizard-file">
              <Paperclip className="icon" aria-hidden />
              Attach .md / .txt / .json / .yaml
              <input
                type="file"
                className="wizard-file-input"
                accept=".md,.txt,.json,.yaml,.yml"
                multiple
                onChange={(e) => void attach(e)}
              />
            </label>
            <span className="muted small">
              {state.referenceDocs.length.toLocaleString()} / {REFERENCE_DOCS_MAX.toLocaleString()}
            </span>
          </div>
          {fileError && (
            <p className="form-error" role="alert">
              {fileError}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
