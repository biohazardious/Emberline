import { useEffect, useRef, useState } from 'react';
import type { ReviewComment } from '@emberline/protocol';
import { useThemeMode } from '../hooks/useThemeMode';
import { loadMonaco, monacoTheme } from '../monaco';
import type * as Monaco from 'monaco-editor';

interface Props {
  filePath: string;
  language: string;
  original: string;
  modified: string;
  renderSideBySide: boolean;
  /** Unresolved comments on this file; line comments get a glyph in the margin (coloured by priority). */
  comments: ReviewComment[];
  /** A click on a line that has no comment glyph starts a line comment there. */
  onLineClick: (line: number, side: 'modified' | 'original') => void;
  /** A click on a comment glyph focuses that comment's chip. */
  onFocusComment: (id: string) => void;
  /** The line a comment is being written for, shown in the hint bar. */
  draftLine: { line: number; side: 'modified' | 'original' } | null;
}

export function MonacoDiff({
  filePath,
  language,
  original,
  modified,
  renderSideBySide,
  comments,
  onLineClick,
  onFocusComment,
  draftLine,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: Monaco.editor.ITextModel;
    modified: Monaco.editor.ITextModel;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const handlersRef = useRef({ onLineClick, onFocusComment });
  handlersRef.current = { onLineClick, onFocusComment };
  const decorationsRef = useRef<{
    original: Monaco.editor.IEditorDecorationsCollection;
    modified: Monaco.editor.IEditorDecorationsCollection;
  } | null>(null);
  const themeMode = useThemeMode();
  const themeRef = useRef(themeMode);
  themeRef.current = themeMode;

  // Monaco themes are global: switching applies to every open editor.
  useEffect(() => {
    if (ready) void loadMonaco().then((monaco) => monaco.editor.setTheme(monacoTheme(themeMode)));
  }, [themeMode, ready]);

  useEffect(() => {
    let cancelled = false;

    void loadMonaco()
      .then((monaco) => {
        if (cancelled || !containerRef.current) return;


        const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
          theme: monacoTheme(themeRef.current),
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

        const onDown = (side: 'modified' | 'original') => (e: Monaco.editor.IEditorMouseEvent) => {
          const line = e.target.position?.lineNumber;
          if (!line) return;
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const hit = commentsRef.current.find((c) => c.side === side && (c.currentLine ?? null) === line);
            if (hit) {
              handlersRef.current.onFocusComment(hit.id);
              return;
            }
          }
          handlersRef.current.onLineClick(line, side);
        };
        const subMod = modEditor.onMouseDown(onDown('modified'));
        const subOrig = origEditor.onMouseDown(onDown('original'));
        decorationsRef.current = {
          original: origEditor.createDecorationsCollection([]),
          modified: modEditor.createDecorationsCollection([]),
        };

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
      decorationsRef.current = null;
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
      applyDecorations.current();
    });
  }, [ready, filePath, language, original, modified]);

  // Glyph-margin markers on commented lines, coloured by priority. Outdated comments have no line.
  // A model's setValue drops decorations, so the content effect applies them again afterwards.
  const applyDecorations = useRef(() => {});
  applyDecorations.current = () => {
    if (!decorationsRef.current) return;
    for (const side of ['original', 'modified'] as const) {
      decorationsRef.current[side].set(
        commentsRef.current.flatMap((c) =>
          c.side === side && c.currentLine !== null && c.currentLine !== undefined
            ? [
                {
                  range: { startLineNumber: c.currentLine, startColumn: 1, endLineNumber: c.currentLine, endColumn: 1 },
                  options: {
                    glyphMarginClassName: `comment-glyph comment-glyph-${c.priority}`,
                    glyphMarginHoverMessage: { value: `${c.priority}: ${c.body.slice(0, 160)}` },
                  },
                },
              ]
            : [],
        ),
      );
    }
  };
  useEffect(() => {
    if (ready) applyDecorations.current();
  }, [ready, comments, original, modified]);

  if (loadError) {
    return (
      <div className="empty review-empty">
        Monaco failed to load ({loadError}).
      </div>
    );
  }

  return (
    <div className="monaco-diff-shell">
      <div className="monaco-diff-hint-bar">
        <span className="muted small">Click any line in the diff to comment on it for the agent</span>
        {draftLine && (
          <span className="badge badge-soft mono">
            Commenting on {filePath}:{draftLine.line} ({draftLine.side})
          </span>
        )}
      </div>
      <div ref={containerRef} className="monaco-diff-canvas" />
    </div>
  );
}
