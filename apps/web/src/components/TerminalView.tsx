import type { TerminalClientMessage, TerminalServerMessage } from '@emberline/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'exited';

const THEME = {
  background: '#0d0907',
  foreground: '#f1e6dc',
  cursor: '#ff8a3d',
  cursorAccent: '#0d0907',
  selectionBackground: '#ff8a3d44',
  black: '#1a1310',
  red: '#ff5c5c',
  green: '#5fd38d',
  yellow: '#ffc457',
  blue: '#6cb6ff',
  magenta: '#e08cff',
  cyan: '#5fd7d7',
  white: '#e8ddd3',
  brightBlack: '#6b5d55',
  brightRed: '#ff7b7b',
  brightGreen: '#7ee2a6',
  brightYellow: '#ffd37a',
  brightBlue: '#8cc8ff',
  brightMagenta: '#ebaaff',
  brightCyan: '#7ee6e6',
  brightWhite: '#fff8f2',
};

/** Keys that are hard to type on a phone keyboard. */
const MOBILE_KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
];

interface Props {
  terminalId: string;
  onStateChange?: (state: ConnectionState) => void;
}

/**
 * Live terminal bound to `/api/terminals/:id/ws`. Reconnects with backoff and restores the
 * screen from the server snapshot, so reloading the page or losing Wi-Fi never loses context.
 */
export function TerminalView({ terminalId, onStateChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const onStateRef = useRef(onStateChange);
  onStateRef.current = onStateChange;
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: window.innerWidth < 640 ? 12 : 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    let ws: WebSocket | undefined;
    let disposed = false;
    let exited = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const update = (next: ConnectionState) => {
      setState(next);
      onStateRef.current?.(next);
    };
    const send = (message: TerminalClientMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // Container not laid out yet.
      }
    };

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/terminals/${encodeURIComponent(terminalId)}/ws`);
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as TerminalServerMessage;
        switch (message.type) {
          case 'snapshot':
            attempt = 0;
            term.reset();
            // Replay at the server's size, then fit to ours (which triggers a resize upstream).
            term.resize(message.cols, message.rows);
            term.write(message.data, () => {
              safeFit();
              send({ type: 'resize', cols: term.cols, rows: term.rows });
            });
            if (message.status === 'exited') {
              exited = true;
              update('exited');
            } else update('live');
            break;
          case 'output':
            term.write(message.data);
            break;
          case 'exit':
            exited = true;
            term.write(`\r\n\x1b[2m[process exited${message.exitCode !== null ? ` with code ${message.exitCode}` : ''}]\x1b[0m\r\n`);
            update('exited');
            break;
          case 'error':
            term.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
            break;
        }
      };
      ws.onclose = () => {
        if (disposed || exited) return;
        update('reconnecting');
        retryTimer = setTimeout(connect, Math.min(500 * 2 ** attempt++, 5_000));
      };
    };

    const dataSub = term.onData((data) => send({ type: 'input', data }));
    const resizeSub = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const observer = new ResizeObserver(() => safeFit());
    observer.observe(container);
    sendInputRef.current = (data) => {
      send({ type: 'input', data });
      term.focus();
    };

    safeFit();
    connect();
    term.focus();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws?.close();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="term-shell" data-state={state}>
      <div className="term-container" ref={containerRef} />
      <div className="keybar" role="toolbar" aria-label="Terminal keys">
        {MOBILE_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="key"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => sendInputRef.current(key.seq)}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
