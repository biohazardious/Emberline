import { LoaderCircle, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, useState } from 'react';
import { errorMessage } from '../api';

const CHUNK_LOAD_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk [\w-]+ failed/i,
  /error loading dynamically imported module/i,
];

/** True when a lazy route bundle failed to load (e.g. network blip or new build deployed). */
export function isChunkLoadError(error: unknown): boolean {
  const msg = errorMessage(error);
  return CHUNK_LOAD_PATTERNS.some((pattern) => pattern.test(msg));
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this key clears a caught error automatically (e.g. route pathname). */
  resetKey?: string | number;
  title?: string;
  compact?: boolean;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Isolates rendering and lazy-chunk failures to a single view or docked pane so the navigation
 * shell stays interactive and recoverable without losing workspace context.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error !== null && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const chunkError = isChunkLoadError(error);
    const heading =
      this.props.title ??
      (chunkError ? 'Could not load this view bundle' : 'This view ran into an unexpected error');
    const detail = errorMessage(error);

    return (
      <section
        className={`error-boundary${this.props.compact ? ' error-boundary-compact' : ''}`}
        role="alert"
        aria-live="assertive"
      >
        <div className="error-boundary-card">
          <div className="error-boundary-head">
            <span className="error-boundary-icon" aria-hidden="true">
              <TriangleAlert className="icon" />
            </span>
            <div>
              <h2 className="error-boundary-title">{heading}</h2>
              <p className="muted small error-boundary-sub">
                {chunkError
                  ? 'A newer Emberline build may be live or the connection dropped while loading this module.'
                  : 'The rest of Emberline is unaffected. You can retry rendering this view or reload the app.'}
              </p>
            </div>
          </div>
          <pre className="error-boundary-detail mono">{detail}</pre>
          <div className="error-boundary-actions">
            <button
              type="button"
              className={`btn btn-sm${chunkError ? '' : ' btn-primary'}`}
              onClick={this.handleReset}
            >
              <RotateCw className="icon" aria-hidden /> Try again
            </button>
            <button
              type="button"
              className={`btn btn-sm${chunkError ? ' btn-primary' : ' btn-ghost'}`}
              onClick={this.handleReload}
            >
              <RefreshCw className="icon" aria-hidden /> Reload page
            </button>
          </div>
        </div>
      </section>
    );
  }
}

/** Accessible inline error banner with an optional Retry action for failed API reads. */
export function ViewErrorBanner({
  error,
  label,
  onRetry,
  compact = false,
}: {
  error: unknown;
  label?: string;
  onRetry?: () => void | Promise<void>;
  compact?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      className={`banner banner-error view-error-banner${compact ? ' view-error-banner-compact' : ''}`}
      role="alert"
    >
      <span className="view-error-copy">
        <TriangleAlert className="icon" aria-hidden />
        <span>
          {label ? <strong>{label}: </strong> : null}
          {errorMessage(error)}
        </span>
      </span>
      {onRetry && (
        <button type="button" className="btn btn-sm" disabled={retrying} onClick={() => void retry()}>
          <RefreshCw className={`icon${retrying ? ' icon-spin' : ''}`} aria-hidden />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}

/** Consistent loading surface for views awaiting their initial query payload. */
export function ViewLoadingState({
  label = 'Loading…',
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div className={`view-loading${compact ? ' view-loading-compact' : ''}`} role="status" aria-busy="true">
      <LoaderCircle className="icon icon-spin" aria-hidden />
      <span className="muted mono small">{label}</span>
    </div>
  );
}
