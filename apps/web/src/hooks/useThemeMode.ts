import { useEffect, useState } from 'react';

const current = (): 'dark' | 'light' =>
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

/** The active UI theme, following changes to `<html data-theme>` (for Monaco, xterm, canvases). */
export function useThemeMode(): 'dark' | 'light' {
  const [mode, setMode] = useState(current);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(current()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return mode;
}
