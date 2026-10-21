import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';
import { loadMonaco } from '../monaco';

export function MonacoEditor({
  filePath,
  language,
  value,
  theme,
  readOnly = false,
  onChange,
}: {
  filePath: string;
  language: string;
  value: string;
  theme: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The editor is (re)created per file/language/theme with the value at that moment; later edits
  // flow in through the effect below, so the creation effect reads the value from a ref.
  const valueRef = useRef(value);
  valueRef.current = value;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  useEffect(() => {
    let cancelled = false;
    let model: Monaco.editor.ITextModel | null = null;
    let sub: Monaco.IDisposable | null = null;

    void loadMonaco().then((monaco) => {
      if (cancelled || !containerRef.current) return;
      model = monaco.editor.createModel(valueRef.current, language);
      const editor = monaco.editor.create(containerRef.current, {
        model,
        theme,
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        readOnly: readOnlyRef.current,
      });
      sub = editor.onDidChangeModelContent(() => {
        onChangeRef.current(editor.getValue());
      });
      editorRef.current = editor;
    });

    return () => {
      cancelled = true;
      sub?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      model?.dispose();
    };
  }, [filePath, language, theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
