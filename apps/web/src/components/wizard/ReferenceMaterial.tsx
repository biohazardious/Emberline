import { Upload } from 'lucide-react';
import { type ChangeEvent, type Dispatch, type DragEvent, useState } from 'react';
import { MaterialList } from './MaterialList';
import { addMaterials, capLine, filesToAddAgain, type MaterialCandidate, notKeptText, parseReferenceUrls } from './materials';
import type { WizardAction, WizardState } from './wizardLogic';

export function ReferenceMaterial({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [linksTouched, setLinksTouched] = useState(false);
  const links = parseReferenceUrls(state.referenceUrlsText);
  const showLinkErrors = linksTouched && links.problems.length > 0;
  const toAddAgain = filesToAddAgain(state.materialsNotKept, state.materials);
  const errors = [...(state.materialsError ? [state.materialsError] : []), ...problems];

  const add = (candidates: MaterialCandidate[]) => {
    const result = addMaterials(state.materials, candidates);
    setProblems(result.problems);
    if (result.added.length > 0) dispatch({ type: 'materialsAdded', materials: result.added });
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    add(files.map((file) => ({ file, name: file.name })));
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const items = [...e.dataTransfer.items].filter((item) => item.kind === 'file');
    add(
      [...e.dataTransfer.files].map((file, i) => ({
        file,
        name: file.name,
        isFolder: items[i]?.webkitGetAsEntry?.()?.isDirectory === true,
      })),
    );
  };

  return (
    <>
      <div
        id="wizard-materials"
        className="field"
        tabIndex={-1}
        role="group"
        aria-labelledby="wizard-materials-label"
        aria-describedby={`wizard-materials-hint wizard-materials-cap${errors.length > 0 ? ' wizard-materials-errors' : ''}`}
      >
        <span id="wizard-materials-label" className="wizard-materials-label">
          Files
        </span>
        <div
          className={`wizard-drop${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="muted small">Drop files here or</span>
          <label className="btn btn-sm wizard-file">
            <Upload className="icon" aria-hidden />
            Add files
            <input type="file" className="wizard-file-input" multiple onChange={onPick} />
          </label>
        </div>
        <p id="wizard-materials-hint" className="muted small">
          Images (PNG, JPEG, WebP, GIF), PDFs and other files such as design exports, up to 10 MB each. They
          are committed to docs/reference/ in the new project.
        </p>
        <p id="wizard-materials-cap" className="muted small" aria-live="polite">
          {capLine(state.materials)}
        </p>
        {toAddAgain.length > 0 && <p className="notice-box">{notKeptText(toAddAgain)}</p>}
        <MaterialList
          materials={state.materials}
          onRemove={(id) => {
            setProblems([]);
            dispatch({ type: 'materialRemoved', id });
          }}
        />
        {errors.length > 0 && (
          <ul id="wizard-materials-errors" className="form-error wizard-material-errors" role="alert">
            {errors.map((p, i) => (
              <li key={`${i}-${p}`}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="field">
        <label htmlFor="wizard-links">Links (optional)</label>
        <textarea
          id="wizard-links"
          className="input wizard-textarea"
          rows={3}
          maxLength={50_000}
          value={state.referenceUrlsText}
          aria-describedby={showLinkErrors ? 'wizard-links-hint wizard-links-errors' : 'wizard-links-hint'}
          aria-invalid={showLinkErrors ? true : undefined}
          onBlur={() => setLinksTouched(true)}
          onChange={(e) => dispatch({ type: 'field', field: 'referenceUrlsText', value: e.target.value })}
        />
        <p id="wizard-links-hint" className="muted small">
          One link per line, starting with http:// or https://, with a short note after it if it helps, for
          example: https://example.com like this one. Emberline never opens these links.
        </p>
        {showLinkErrors && (
          <ul id="wizard-links-errors" className="form-error" role="alert">
            {links.problems.map((p, i) => (
              <li key={`${i}-${p}`}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
