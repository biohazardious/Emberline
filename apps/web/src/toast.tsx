import { useEffect, useState } from 'react';

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener(toasts);
}

function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  publish();
}

function push(kind: Toast['kind'], text: string): void {
  const id = nextId++;
  toasts = [...toasts.slice(-3), { id, kind, text }];
  publish();
  setTimeout(() => dismiss(id), kind === 'error' ? 8_000 : 4_000);
}

/** Surfaces a failed user action instead of swallowing it. */
export const toastError = (text: string) => push('error', text);
export const toastInfo = (text: string) => push('info', text);

/** Renders the toast stack; mount once in the shell. */
export function Toasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  if (list.length === 0) return null;
  return (
    <div className="toast-stack">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
