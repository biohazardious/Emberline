import {
  type AdoptPreviewResponse,
  getPreset,
  getProjectType,
  PROJECT_GATE_KEYS,
  type ProjectPreviewResponse,
  STACK_DIMENSIONS,
  VERSION_POLICIES,
} from '@emberline/protocol';
import { type Dispatch, type ReactNode, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { GATE_LABELS } from '../../projectSettings';
import { PERSONA_BY_ID } from '../PersonaBadge';
import { SettingRow } from '../ui/SettingRow';
import { MaterialList } from './MaterialList';
import { parseReferenceUrls, summaryMaterialsNote } from './materials';
import { type PreviewState, SummaryFilesSection, type SummaryPreview } from './SummaryFilesSection';
import {
  buildAdoptBody,
  buildPreviewBody,
  choiceLabel,
  isImport,
  type StepId,
  type WizardAction,
  type WizardState,
} from './wizardLogic';

export type { PreviewState, SummaryPreview };

/**
 * What creation (or adopt) would write, from the server's own generators. Debounced; a request
 * for an older body never replaces a newer one. Create stays disabled until it succeeds.
 */
export function useSummaryPreview(state: WizardState, active: boolean): PreviewState {
  const imported = isImport(state.source);
  const projectId = state.importProjectId;
  const body = imported ? buildAdoptBody(state) : buildPreviewBody(state);
  const key = `${projectId ?? ''}|${JSON.stringify(body)}`;
  const [result, setResult] = useState<{ key: string; error: string | null } | null>(null);
  const [lastGood, setLastGood] = useState<SummaryPreview | null>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => {
    if (!active || (imported && !projectId)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const request = imported
        ? api<AdoptPreviewResponse>(`/api/projects/${projectId}/adopt/preview`, 'POST', bodyRef.current).then(
            (data): SummaryPreview => ({ kind: 'adopt', data }),
          )
        : api<ProjectPreviewResponse>('/api/projects/preview', 'POST', bodyRef.current).then(
            (data): SummaryPreview => ({ kind: 'new', data }),
          );
      request.then(
        (preview) => {
          if (cancelled) return;
          setLastGood(preview);
          setResult({ key, error: null });
        },
        (err: unknown) => {
          if (!cancelled) setResult({ key, error: errorMessage(err) });
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, imported, projectId, key]);

  const current = result?.key === key ? result : null;
  return {
    preview: lastGood,
    ready: current !== null && current.error === null,
    error: current?.error ?? null,
    loading: active && current === null,
  };
}

const Item = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

const truncate = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function StepSummary({
  state,
  dispatch,
  preview,
  onEdit,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  preview: PreviewState;
  onEdit: (step: StepId) => void;
}) {
  const imported = isImport(state.source);
  const links = parseReferenceUrls(state.referenceUrlsText).urls;
  const type = state.appType ? getProjectType(state.appType)?.label : undefined;
  const preset = state.presetId ? getPreset(state.presetId) : undefined;
  const data = preview.preview;

  const primaryStack = STACK_DIMENSIONS.filter((d) => !d.advanced)
    .map((d) => choiceLabel(d.id, state.choices[d.id]))
    .filter((v) => v !== 'None' && v !== 'Let the agent decide' && v !== 'Not set')
    .slice(0, 4);
  const stackSummary = primaryStack.length > 0 ? primaryStack.join(' · ') : 'Agent decides stack';

  const overrideCount = PROJECT_GATE_KEYS.filter((k) => state.gates[k] !== undefined).length;
  const gateSummary =
    overrideCount === 0
      ? 'Default gates'
      : `${overrideCount} gate ${overrideCount === 1 ? 'override' : 'overrides'}`;
  const startModeLabel = `${imported ? 'Import' : 'Create'}${state.startFactory ? ' and start factory' : ' only'}`;

  return (
    <div className="wizard-step">
      <div className="wizard-summary-rows">
        {imported ? (
          <SettingRow
            label="Repository"
            summary={
              <>
                <span className="mono">
                  {state.source === 'import_folder' ? state.folder : state.repoUrl.trim()}
                </span>{' '}
                · {state.name.trim()} · {type ?? 'Custom'}
              </>
            }
          />
        ) : (
          <SettingRow
            label="Project"
            summary={
              <>
                <strong>{state.name.trim()}</strong>
                {type ? ` · ${type}` : ''}
                {preset ? ` · ${preset.label}` : ''}
                {state.vision.trim() ? ` — ${truncate(state.vision.trim())}` : ''}
              </>
            }
            control={
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label="Edit project"
                onClick={() => onEdit('type')}
              >
                Edit
              </button>
            }
          />
        )}

        {!imported &&
          (state.materials.length > 0 || links.length > 0 || state.referenceDocs.trim() !== '') && (
            <SettingRow
              label="Reference material"
              summary={
                <>
                  {state.materials.length > 0 ? `${state.materials.length} files` : ''}
                  {links.length > 0 ? `${state.materials.length > 0 ? ' · ' : ''}${links.length} links` : ''}
                  {state.referenceDocs.trim()
                    ? `${state.materials.length > 0 || links.length > 0 ? ' · ' : ''}${state.referenceDocs.trim().length.toLocaleString()} chars`
                    : ''}
                </>
              }
              control={
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label="Edit reference material"
                  onClick={() => onEdit('type')}
                >
                  Edit
                </button>
              }
              details={
                <div>
                  <MaterialList
                    materials={state.materials}
                    paths={
                      preview.ready && data?.kind === 'new'
                        ? data.data.materials.map((m) => m.path)
                        : undefined
                    }
                  />
                  {links.length > 0 && (
                    <ul className="wizard-files">
                      {links.map((u, i) => (
                        <li key={`${i} ${u.url}`}>
                          <span className="mono">{u.url}</span>
                          {u.note && <span className="muted small"> · {u.note}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {(state.materials.length > 0 || links.length > 0) && (
                    <p className="muted small">
                      {summaryMaterialsNote(state.materials.length, links.length)}
                    </p>
                  )}
                </div>
              }
            />
          )}

        <SettingRow
          label="Stack"
          summary={
            <>
              {stackSummary}
              {!imported && (
                <>
                  {' · '}
                  <span className="mono">{state.defaultBranch.trim()}</span>
                </>
              )}
            </>
          }
          control={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label="Edit stack"
              onClick={() => onEdit('stack')}
            >
              Edit
            </button>
          }
          details={
            <dl className="wizard-sum-list">
              {STACK_DIMENSIONS.map((d) => (
                <Item key={d.id} label={d.label}>
                  {choiceLabel(d.id, state.choices[d.id])}
                </Item>
              ))}
              {!imported && (
                <>
                  <Item label="Default branch">
                    <span className="mono">{state.defaultBranch.trim()}</span>
                  </Item>
                  <Item label="Version policy">
                    {VERSION_POLICIES.find((p) => p.id === state.versionPolicy)?.label}
                  </Item>
                </>
              )}
            </dl>
          }
        />

        <SettingRow
          label="Factory"
          summary={`${startModeLabel} · ${gateSummary}`}
          control={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label="Edit factory"
              onClick={() => onEdit('factory')}
            >
              Edit
            </button>
          }
          details={
            <dl className="wizard-sum-list">
              {PROJECT_GATE_KEYS.map((key) => (
                <Item key={key} label={GATE_LABELS[key].label}>
                  {state.gates[key] === undefined ? 'Inherit' : state.gates[key] ? 'On' : 'Off'}
                </Item>
              ))}
              <Item label="Start mode">{startModeLabel}</Item>
              {imported && (
                <Item label="Vision">
                  {state.vision.trim() ? (
                    truncate(state.vision.trim(), 240)
                  ) : (
                    <span className="muted">None</span>
                  )}
                </Item>
              )}
            </dl>
          }
        />

        <SettingRow
          label="Tickets"
          summary={
            imported
              ? state.startFactory
                ? `[Factory] from vision (${PERSONA_BY_ID.product_owner.label})`
                : 'No initial tickets'
              : data?.kind === 'new'
                ? data.data.tickets.map((t) => t.title).join(' · ')
                : preview.loading
                  ? 'Loading…'
                  : '—'
          }
        />
      </div>

      <SummaryFilesSection state={state} dispatch={dispatch} preview={preview} />
    </div>
  );
}
