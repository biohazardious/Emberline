import type { BrowserViewportSnapshot } from '@emberline/protocol';
import type { FormEvent, MouseEvent } from 'react';
import { Disclosure } from '../ui/Disclosure';
import type { BrowserDeviceSize } from './LiveBrowserToolbar';

export const QUICK_KEYS = [
  { label: 'Press Space', key: 'Space' },
  { label: 'Press Enter', key: 'Enter' },
  { label: 'Press Esc', key: 'Escape' },
  { label: 'Press Up', key: 'ArrowUp' },
  { label: 'Press Down', key: 'ArrowDown' },
  { label: 'Press Left', key: 'ArrowLeft' },
  { label: 'Press Right', key: 'ArrowRight' },
  { label: 'Press Tab', key: 'Tab' },
  { label: 'Press Backspace', key: 'Backspace' },
] as const;

export interface LiveBrowserViewportProps {
  snap: BrowserViewportSnapshot | null;
  loading: boolean;
  acting: boolean;
  deviceSize: BrowserDeviceSize;
  clickMarker: { xPct: number; yPct: number; id: number } | null;
  typeInput: string;
  onTypeInputChange: (next: string) => void;
  onCanvasClick: (e: MouseEvent<HTMLImageElement>) => void;
  onTypeSubmit: (e: FormEvent, submitKey: boolean) => void;
  onPressKey: (key: string) => void;
}

export function LiveBrowserViewport({
  snap,
  loading,
  acting,
  deviceSize,
  clickMarker,
  typeInput,
  onTypeInputChange,
  onCanvasClick,
  onTypeSubmit,
  onPressKey,
}: LiveBrowserViewportProps) {
  const frameSizeClass =
    deviceSize === 'tablet'
      ? ' live-browser-frame-tablet'
      : deviceSize === 'mobile'
        ? ' live-browser-frame-mobile'
        : '';

  return (
    <div className="live-browser-stage-col">
      <div className="live-browser-canvas-wrap">
        {snap?.imageDataUrl ? (
          <div className={`live-browser-frame${frameSizeClass}`}>
            <img
              src={snap.imageDataUrl}
              alt="Shared live browser viewport"
              className="live-browser-canvas-img"
              onClick={onCanvasClick}
            />
            {clickMarker && (
              <span
                key={clickMarker.id}
                className="live-browser-click-marker"
                style={{
                  left: `${clickMarker.xPct}%`,
                  top: `${clickMarker.yPct}%`,
                }}
              />
            )}
          </div>
        ) : (
          <div className="muted small live-browser-empty">
            {loading ? 'Connecting to runner browser…' : (snap?.message ?? 'No browser frame available yet.')}
          </div>
        )}
      </div>

      <div className="live-browser-controls-bar">
        <Disclosure label="Send keys">
          <div className="live-browser-controls-body">
            <form onSubmit={(e) => onTypeSubmit(e, true)} className="browser-type-form">
              <input
                type="text"
                className="input browser-type-input"
                value={typeInput}
                onChange={(e) => onTypeInputChange(e.target.value)}
                aria-label="Text to type into browser"
                placeholder="Type text into focused element…"
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={acting || !typeInput}
                onClick={(e) => onTypeSubmit(e as unknown as FormEvent, false)}
              >
                Send text
              </button>
              <button type="submit" className="btn btn-sm" disabled={acting || !typeInput}>
                Send with Enter
              </button>
            </form>

            <div className="live-browser-keys-row">
              {QUICK_KEYS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  className="chip-btn mono live-browser-key-btn"
                  disabled={acting}
                  onClick={() => onPressKey(k.key)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
