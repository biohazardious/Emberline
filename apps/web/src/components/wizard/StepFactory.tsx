import {
  type AgentId,
  type AgentPersona,
  type FactorySettings,
  PROJECT_GATE_KEYS,
  PROVIDER_REGISTRY,
  type Route,
} from '@emberline/protocol';
import type { Dispatch, MouseEvent } from 'react';
import { Link } from 'wouter';
import { gateChoice, GATE_LABELS } from '../../projectSettings';
import { GateRadios } from '../ProjectSettingsPanel';
import { choiceLabel, gateOptions, isImport, type WizardAction, type WizardState } from './wizardLogic';

/** The personas the created tickets start with. */
const CHAIN_PERSONAS: { id: AgentPersona; label: string; runs: string }[] = [
  { id: 'architect', label: 'Architect', runs: 'Bootstrap and Deploy tickets' },
  { id: 'product_owner', label: 'Product owner', runs: '[Factory] ticket' },
  { id: 'coder', label: 'Coder', runs: 'the tickets the product owner writes' },
];

const routeLabel = (r: Route) =>
  `${PROVIDER_REGISTRY[r.agent as AgentId]?.shortLabel ?? r.agent} · ${r.model}${r.credential === 'login' ? '' : ` (${r.credential})`}`;

export function StepFactory({
  state,
  dispatch,
  factory,
  factoryError,
  onEditDeploy,
  onSettings,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  factory: FactorySettings | undefined;
  factoryError: string | null;
  /** Jumps to the Stack step with the deploy row focused. */
  onEditDeploy: () => void;
  /** Leaving for Settings closes the wizard, after the same confirm as Close; the draft stays to restore. */
  onSettings: (e: MouseEvent) => void;
}) {
  const imported = isImport(state.source);
  const verb = imported ? 'Import' : 'Create';
  const startOptions = [
    {
      value: true,
      label: `${verb} and start factory`,
      hint: imported
        ? 'Adds a [Factory] ticket from the vision and starts it.'
        : 'Starts the Bootstrap ticket now; the product owner takes the vision once it is merged.',
    },
    { value: false, label: `${verb} only`, hint: imported ? 'Adopts the project and starts nothing.' : 'Creates the tickets and starts nothing.' },
  ];

  return (
    <div className="wizard-step">
      <section className="wizard-section" aria-labelledby="wizard-gates-title">
        <h4 id="wizard-gates-title" className="wizard-legend">
          Gates
        </h4>
        <p className="muted small">
          Inherit follows the global setting, including later changes to it. Gates are stored in Emberline, never in the
          repository.
        </p>
        {factoryError && (
          <p className="muted small" role="alert">
            Couldn&apos;t load the global gate values ({factoryError}).
          </p>
        )}
        <ul className="gate-list">
          {PROJECT_GATE_KEYS.map((key, i) => (
            <li key={key} className="gate-row">
              <div>
                <span id={`wizard-gate-${key}`}>{GATE_LABELS[key].label}</span>
                <p className="muted small">{GATE_LABELS[key].hint}</p>
              </div>
              <span data-autofocus={i === 0 ? '' : undefined} className="wizard-gate-radios">
                <GateRadios
                  name={`wizard-gate-${key}`}
                  labelledBy={`wizard-gate-${key}`}
                  options={gateOptions(factory, key)}
                  value={gateChoice(state.gates, key)}
                  disabled={false}
                  onChange={(choice) => dispatch({ type: 'gate', key, choice })}
                />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="wizard-section" aria-labelledby="wizard-deploy-title">
        <h4 id="wizard-deploy-title" className="wizard-legend">
          Deploy target
        </h4>
        <div className="wizard-readonly">
          <span>{choiceLabel('deploy', state.choices.deploy)}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onEditDeploy} aria-label="Edit the deploy target">
            Edit
          </button>
        </div>
        <p className="muted small">
          {state.choices.deploy === 'none'
            ? 'No deploy ticket.'
            : imported
              ? 'Recorded in the project files; the agent prepares it when you ask.'
              : 'A Deploy ticket after Bootstrap prepares config and docs for it, with no credentials in the repository.'}
        </p>
      </section>

      <fieldset className="wizard-fieldset">
        <legend className="wizard-legend">Start mode</legend>
        <div className="wizard-cards wizard-cards-2">
          {startOptions.map((o) => (
            <label key={String(o.value)} className="wizard-card">
              <input
                type="radio"
                name="wizard-start"
                checked={state.startFactory === o.value}
                onChange={() => dispatch({ type: 'field', field: 'startFactory', value: o.value })}
              />
              <span className="wizard-card-title">{o.label}</span>
              <span className="wizard-card-hint">{o.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {imported ? (
        <div className="field">
          <label htmlFor="wizard-import-vision">Vision{state.startFactory ? '' : ' (optional)'}</label>
          <textarea
            id="wizard-import-vision"
            className="input wizard-textarea"
            rows={4}
            maxLength={4000}
            aria-describedby="wizard-import-vision-hint"
            value={state.vision}
            onChange={(e) => dispatch({ type: 'field', field: 'vision', value: e.target.value })}
          />
          <p id="wizard-import-vision-hint" className="muted small">
            What to build next in this repository. Starting the factory needs it.
          </p>
        </div>
      ) : (
        state.startFactory &&
        !state.vision.trim() && (
          <p className="muted small">
            Without a vision only the Bootstrap ticket runs; add one on the Type step to get a [Factory] ticket.
          </p>
        )
      )}

      <section className="wizard-section" aria-labelledby="wizard-routes-title">
        <h4 id="wizard-routes-title" className="wizard-legend">
          Routes
        </h4>
        {factory ? (
          <dl className="wizard-routes">
            {CHAIN_PERSONAS.filter((p) => !imported || p.id !== 'architect').map((p) => (
              <div key={p.id}>
                <dt>
                  {p.label} <span className="muted">· {p.runs}</span>
                </dt>
                <dd className="mono">{(factory.personaRoutes[p.id] ?? []).map(routeLabel).join(' → ') || 'Not set'}</dd>
              </div>
            ))}
          </dl>
        ) : (
          !factoryError && <p className="muted small">Loading the routes…</p>
        )}
        <p className="muted small">
          Routes are global.{' '}
          <Link href="/settings" onClick={onSettings}>
            Change them in Settings
          </Link>{' '}
          (closes the wizard; you can restore it later).
        </p>
      </section>
    </div>
  );
}
