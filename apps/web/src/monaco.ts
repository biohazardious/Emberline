import type * as Monaco from 'monaco-editor';

let monacoPromise: Promise<typeof Monaco> | null = null;

/** Loads Monaco once (code-split) and registers the Emberline light and dark editor themes. */
export function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    // A no-op worker keeps diff computation working without bundling Monaco's workers in Vite.
    const globalScope = globalThis as unknown as {
      MonacoEnvironment?: { getWorker: () => Worker };
    };
    if (!globalScope.MonacoEnvironment) {
      globalScope.MonacoEnvironment = {
        getWorker: () => {
          const blob = new Blob(['self.onmessage = function() {};'], { type: 'application/javascript' });
          return new Worker(URL.createObjectURL(blob));
        },
      };
    }
    monacoPromise = import('monaco-editor').then((monaco) => {
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
      monaco.editor.defineTheme('emberline-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#ffffff',
          'editor.lineHighlightBackground': '#f3f4f8',
          'editorGutter.background': '#ffffff',
          'diffEditor.insertedTextBackground': '#16a34a22',
          'diffEditor.removedTextBackground': '#dc262622',
          'diffEditor.insertedLineBackground': '#16a34a12',
          'diffEditor.removedLineBackground': '#dc262612',
          'editorLineNumber.foreground': '#9aa1b2',
          'editorLineNumber.activeForeground': '#c2410c',
        },
      });
      return monaco;
    });
  }
  return monacoPromise;
}

export const monacoTheme = (mode: 'dark' | 'light') =>
  mode === 'light' ? 'emberline-light' : 'emberline-dark';
