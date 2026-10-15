import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';

export interface DiffAnnotation {
  id: string;
  filePath: string;
  line: number;
  side: 'modified' | 'original';
  comment: string;
  /** `sent` once it went to the agent in a "request changes" prompt. */
  status?: 'open' | 'sent';
}

interface Props {
  filePath: string;
  language: string;
  original: string;
  modified: string;
  renderSideBySide: boolean;
  annotations: DiffAnnotation[];
  onAddAnnotation: (line: number, side: 'modified' | 'original', comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
}

let monacoPromise: Promise<typeof Monaco> | null = null;
let themeDefined = false;

function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    // Configure a lightweight no-op worker fallback so Monaco diff calculation
    // works reliably without complex worker bundling in Vite.
    const globalScope = globalThis as unknown as {
      MonacoEnvironment?: { getWorker: () => Worker };
    };
    if (!globalScope.MonacoEnvironment) {
      globalScope.MonacoEnvironment = {
        getWorker: () => {
          const blob = new Blob(['self.onmessage = function() {};'], {
            type: 'application/javascript',
          });
          return new Worker(URL.createObjectURL(blob));
        },
      };
    }
    monacoPromise = import('monaco-editor');
  }
  return monacoPromise;
}

export function MonacoDiff({
  filePath,
  language,
  original,
  modified,
  renderSideBySide,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: Monaco.editor.ITextModel;
    modified: Monaco.editor.ITextModel;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftLine, setDraftLine] = useState<{
    line: number;
    side: 'modified' | 'original';
  } | null>(null);
  const [draftComment, setDraftComment] = useState('');

  useEffect(() => {
    let cancelled = false;

    void loadMonaco()
      .then((monaco) => {
        if (cancelled || !containerRef.current) return;

        if (!themeDefined) {
          monaco.editor.defineTheme('emberline-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
              'editor.background': '#090a0d',
              'editor.lineHighlightBackground': '#111319',
              'editorGutter.background': '#090a0d',
              'diffEditor.insertedTextBackground': '#22c55e18',
              'diffEditor.removedTextBackground': '#ef444418',
              'diffEditor.insertedLineBackground': '#22c55e12',
              'diffEditor.removedLineBackground': '#ef444412',
              'editorLineNumber.foreground': '#555b6e',
              'editorLineNumber.activeForeground': '#ff6b2b',
            },
          });
          themeDefined = true;
        }

        const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
          theme: 'emberline-dark',
          readOnly: true,
          originalEditable: false,
          renderSideBySide,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineHeight: 19,
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          renderIndicators: true,
          glyphMargin: true,
          padding: { top: 8, bottom: 8 },
        });

        const origModel = monaco.editor.createModel(original, language);
        const modModel = monaco.editor.createModel(modified, language);
        diffEditor.setModel({ original: origModel, modified: modModel });

        const modEditor = diffEditor.getModifiedEditor();
        const origEditor = diffEditor.getOriginalEditor();

        const subMod = modEditor.onMouseDown((e) => {
          if (e.target.position?.lineNumber) {
            setDraftLine({ line: e.target.position.lineNumber, side: 'modified' });
          }
        });
        const subOrig = origEditor.onMouseDown((e) => {
          if (e.target.position?.lineNumber) {
            setDraftLine({ line: e.target.position.lineNumber, side: 'original' });
          }
        });

        diffEditorRef.current = diffEditor;
        modelsRef.current = { original: origModel, modified: modModel };
        setReady(true);

        return () => {
          subMod.dispose();
          subOrig.dispose();
        };
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
      if (diffEditorRef.current) {
        diffEditorRef.current.dispose();
        diffEditorRef.current = null;
      }
      if (modelsRef.current) {
        modelsRef.current.original.dispose();
        modelsRef.current.modified.dispose();
        modelsRef.current = null;
      }
    };
    // Re-create only when mounting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (diffEditorRef.current) {
      diffEditorRef.current.updateOptions({ renderSideBySide });
    }
  }, [renderSideBySide]);

  useEffect(() => {
    if (!ready || !modelsRef.current) return;
    void loadMonaco().then((monaco) => {
      if (!modelsRef.current) return;
      const { original: origModel, modified: modModel } = modelsRef.current;
      if (origModel.getValue() !== original) {
        origModel.setValue(original);
      }
      if (modModel.getValue() !== modified) {
        modModel.setValue(modified);
      }
      monaco.editor.setModelLanguage(origModel, language);
      monaco.editor.setModelLanguage(modModel, language);
    });
    setDraftLine(null);
  }, [ready, filePath, language, original, modified]);

  const fileAnnotations = annotations.filter((a) => a.filePath === filePath);

  const handleSaveAnnotation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftLine || !draftComment.trim()) return;
    onAddAnnotation(draftLine.line, draftLine.side, draftComment.trim());
    setDraftComment('');
    setDraftLine(null);
  };

  if (loadError) {
    return (
      <div className="empty" style={{ margin: '1rem' }}>
        Monaco failed to load ({loadError}).
      </div>
    );
  }

  return (
    <div className="monaco-diff-shell">
      <div className="monaco-diff-hint-bar">
        <span className="muted small">
          Click any line in the diff to attach an inline review comment for Claude
        </span>
        {draftLine && (
          <span className="badge badge-soft mono">
            Commenting on {filePath}:{draftLine.line} ({draftLine.side})
          </span>
        )}
      </div>

      {draftLine && (
        <form className="diff-annotation-composer" onSubmit={handleSaveAnnotation}>
          <span className="mono" style={{ fontSize: '0.74rem', color: 'var(--accent)' }}>
            {filePath}:{draftLine.line}
          </span>
          <input
            type="text"
            className="input"
            value={draftComment}
            onChange={(e) => setDraftComment(e.target.value)}
            placeholder="Write line review feedback (e.g. 'Handle null check here' or 'Extract helper')…"
            autoFocus
            style={{ flex: 1 }}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={!draftComment.trim()}>
            Add Note
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setDraftLine(null);
              setDraftComment('');
            }}
          >
            Cancel
          </button>
        </form>
      )}

      {fileAnnotations.length > 0 && (
        <div className="diff-file-annotations">
          {fileAnnotations.map((a) => (
            <div key={a.id} className={`diff-annotation-chip${a.status === 'sent' ? ' diff-annotation-sent' : ''}`}>
              <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                L{a.line} ({a.side})
              </span>
              <span style={{ flex: 1 }}>{a.comment}</span>
              {a.status === 'sent' && (
                <span className="badge badge-soft" title="Sent to the agent; resolve it once addressed">
                  sent
                </span>
              )}
              <button
                type="button"
                className="icon-btn"
                onClick={() => onRemoveAnnotation(a.id)}
                title={a.status === 'sent' ? 'Mark resolved' : 'Delete comment'}
              >
                {a.status === 'sent' ? '✓' : '×'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={containerRef} className="monaco-diff-canvas" />
    </div>
  );
}
