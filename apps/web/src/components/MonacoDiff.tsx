import type { ReviewComment } from '@emberline/protocol';
import type * as Monaco from 'monaco-editor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThemeMode } from '../hooks/useThemeMode';
import { loadMonaco, monacoTheme } from '../monaco';
import { glyphHoverText } from '../reviewComments';
import { LazyMonacoModelPool } from './review/monacoModelPool';

const PREVIEW_LINE_CAP = 140;

interface Props {
  filePath: string;
  language: string;
  original: string;
  modified: string;
  patch?: string;
  renderSideBySide: boolean;
  /** Unresolved comments on this file; line comments get a glyph in the margin (coloured by priority). */
  comments: ReviewComment[];
  /** A click on a line that has no comment glyph starts a line comment there. */
  onLineClick: (line: number, side: 'modified' | 'original') => void;
  /** A click on a comment glyph focuses that comment's chip. */
  onFocusComment: (id: string) => void;
  /** Tracks cursor/line selection so keyboard `c` attaches to the active line. */
  onActiveLineChange?: (pos: { line: number; side: 'modified' | 'original' } | null) => void;
  /** Scrolls the diff editor to a specific line when jumping to a comment. */
  revealTarget?: { line: number; side: 'modified' | 'original'; nonce: number } | null;
  /** The line a comment is being written for, shown in the hint bar. */
  draftLine: { line: number; side: 'modified' | 'original' } | null;
}

export function MonacoDiff({
  filePath,
  language,
  original,
  modified,
  patch,
  renderSideBySide,
  comments,
  onLineClick,
  onFocusComment,
  onActiveLineChange,
  revealTarget,
  draftLine,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const poolRef = useRef<LazyMonacoModelPool<Monaco.editor.ITextModel> | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const handlersRef = useRef({ onLineClick, onFocusComment, onActiveLineChange });
  handlersRef.current = { onLineClick, onFocusComment, onActiveLineChange };
  const initialSideBySideRef = useRef(renderSideBySide);
  const initialContentRef = useRef({ filePath, language, original, modified });
  initialContentRef.current = { filePath, language, original, modified };

  const decorationsRef = useRef<{
    original: Monaco.editor.IEditorDecorationsCollection;
    modified: Monaco.editor.IEditorDecorationsCollection;
  } | null>(null);

  const themeMode = useThemeMode();
  const themeRef = useRef(themeMode);
  themeRef.current = themeMode;

  useEffect(() => {
    if (ready) void loadMonaco().then((monaco) => monaco.editor.setTheme(monacoTheme(themeMode)));
  }, [themeMode, ready]);

  const applyDecorations = useRef(() => {});
  applyDecorations.current = () => {
    if (!decorationsRef.current) return;
    for (const side of ['original', 'modified'] as const) {
      decorationsRef.current[side].set(
        commentsRef.current.flatMap((c) =>
          c.side === side && c.currentLine !== null && c.currentLine !== undefined
            ? [
                {
                  range: {
                    startLineNumber: c.currentLine,
                    startColumn: 1,
                    endLineNumber: c.currentLine,
                    endColumn: 1,
                  },
                  options: {
                    glyphMarginClassName: `comment-glyph comment-glyph-${c.priority}`,
                    glyphMarginHoverMessage: {
                      value: glyphHoverText(c),
                      isTrusted: false,
                      supportHtml: false,
                    },
                  },
                },
              ]
            : [],
        ),
      );
    }
  };

  useEffect(() => {
    let cancelled = false;
    let disposeSubs: (() => void) | null = null;
    let rafId = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const mountMonaco = () => {
      void loadMonaco()
        .then((monaco) => {
          if (cancelled || !containerRef.current) return;

          const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
            theme: monacoTheme(themeRef.current),
            readOnly: true,
            originalEditable: false,
            renderSideBySide: initialSideBySideRef.current,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            maxComputationTime: 1000,
            diffWordWrap: 'off',
            fontSize: 12,
            lineHeight: 19,
            fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            renderIndicators: true,
            glyphMargin: true,
            padding: { top: 8, bottom: 8 },
          });

          const pool = new LazyMonacoModelPool<Monaco.editor.ITextModel>(monaco.editor, 12);
          const cur = initialContentRef.current;
          const pair = pool.acquire(`${cur.filePath}\0${cur.language}`, {
            original: cur.original,
            modified: cur.modified,
            language: cur.language,
          });
          diffEditor.setModel({ original: pair.original, modified: pair.modified });

          const modEditor = diffEditor.getModifiedEditor();
          const origEditor = diffEditor.getOriginalEditor();

          const onDown = (side: 'modified' | 'original') => (e: Monaco.editor.IEditorMouseEvent) => {
            const line = e.target.position?.lineNumber;
            if (!line) return;
            handlersRef.current.onActiveLineChange?.({ line, side });
            if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
              const hit = commentsRef.current.find(
                (c) => c.side === side && (c.currentLine ?? null) === line,
              );
              if (hit) {
                handlersRef.current.onFocusComment(hit.id);
                return;
              }
            }
            handlersRef.current.onLineClick(line, side);
          };

          const subMod = modEditor.onMouseDown(onDown('modified'));
          const subOrig = origEditor.onMouseDown(onDown('original'));
          const subCursorMod = modEditor.onDidChangeCursorPosition((e) => {
            handlersRef.current.onActiveLineChange?.({ line: e.position.lineNumber, side: 'modified' });
          });
          const subCursorOrig = origEditor.onDidChangeCursorPosition((e) => {
            handlersRef.current.onActiveLineChange?.({ line: e.position.lineNumber, side: 'original' });
          });

          decorationsRef.current = {
            original: origEditor.createDecorationsCollection([]),
            modified: modEditor.createDecorationsCollection([]),
          };

          diffEditorRef.current = diffEditor;
          poolRef.current = pool;
          applyDecorations.current();
          setReady(true);

          disposeSubs = () => {
            subMod.dispose();
            subOrig.dispose();
            subCursorMod.dispose();
            subCursorOrig.dispose();
          };
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setLoadError(err instanceof Error ? err.message : String(err));
          }
        });
    };

    // Yield post-paint so the fast diff preview settles before Monaco's bundle executes.
    rafId = window.requestAnimationFrame(() => {
      idleTimer = setTimeout(mountMonaco, 180);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      if (idleTimer !== null) clearTimeout(idleTimer);
      disposeSubs?.();
      decorationsRef.current = null;
      const editor = diffEditorRef.current;
      const pool = poolRef.current;
      diffEditorRef.current = null;
      poolRef.current = null;
      if (pool) {
        pool.disposeAll(() => editor?.setModel(null));
      }
      if (editor) {
        editor.dispose();
      }
    };
  }, []);

  useEffect(() => {
    if (diffEditorRef.current) {
      diffEditorRef.current.updateOptions({ renderSideBySide });
    }
  }, [renderSideBySide]);

  useEffect(() => {
    if (!ready || !diffEditorRef.current || !poolRef.current) return;
    const editor = diffEditorRef.current;
    const pair = poolRef.current.acquire(`${filePath}\0${language}`, { original, modified, language }, () =>
      editor.setModel(null),
    );
    const current = editor.getModel();
    if (!current || current.original !== pair.original || current.modified !== pair.modified) {
      editor.setModel({ original: pair.original, modified: pair.modified });
    }
    applyDecorations.current();
  }, [ready, filePath, language, original, modified]);

  useEffect(() => {
    if (ready) applyDecorations.current();
  }, [ready, comments, original, modified]);

  useEffect(() => {
    if (!ready || !revealTarget || !diffEditorRef.current) return;
    const targetEditor =
      revealTarget.side === 'original'
        ? diffEditorRef.current.getOriginalEditor()
        : diffEditorRef.current.getModifiedEditor();
    targetEditor.revealLineInCenter(revealTarget.line);
    targetEditor.setPosition({ lineNumber: revealTarget.line, column: 1 });
  }, [ready, revealTarget]);

  const previewLines = useMemo(() => {
    if (ready) return [];
    const source = patch && patch.trim() ? patch : modified || original;
    return source.split('\n').slice(0, PREVIEW_LINE_CAP);
  }, [ready, patch, modified, original]);

  if (loadError) {
    return <div className="empty review-empty">Monaco failed to load ({loadError}).</div>;
  }

  return (
    <div className="monaco-diff-shell" data-diff-file={filePath} data-monaco-ready={ready ? 'true' : 'false'}>
      <div className="monaco-diff-hint-bar">
        <span className="muted small">
          Click any line or press <kbd className="kbd">c</kbd> to comment · <kbd className="kbd">j</kbd>/
          <kbd className="kbd">k</kbd> files · <kbd className="kbd">n</kbd>/<kbd className="kbd">p</kbd>{' '}
          comments · <kbd className="kbd">?</kbd> shortcuts
        </span>
        {draftLine && (
          <span className="badge badge-soft mono review-tabular">
            Commenting on {filePath}:{draftLine.line} ({draftLine.side})
          </span>
        )}
      </div>

      <div className="monaco-diff-stage">
        {!ready && (
          <div
            className="review-fast-diff-preview mono"
            role="region"
            aria-label={`Diff preview for ${filePath}`}
          >
            {previewLines.map((line, idx) => {
              const lineNo = idx + 1;
              const kind =
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'add'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'del'
                    : line.startsWith('@@')
                      ? 'hunk'
                      : 'ctx';
              return (
                <div
                  key={lineNo}
                  className={`review-fast-diff-line review-fast-diff-${kind}`}
                  onClick={() => onLineClick(lineNo, 'modified')}
                >
                  <span className="review-fast-diff-ln review-tabular">{lineNo}</span>
                  <span className="review-fast-diff-code">{line || ' '}</span>
                </div>
              );
            })}
          </div>
        )}

        <div ref={containerRef} className="monaco-diff-canvas" />
      </div>
    </div>
  );
}
