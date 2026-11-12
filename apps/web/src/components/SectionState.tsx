import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { errorMessage } from '../api';

/** Renders a Lucide icon with the standard `.icon` class and `aria-hidden`. */
export function ico(Icon: LucideIcon, spin?: boolean) {
  return <Icon className={spin ? 'icon icon-spin' : 'icon'} aria-hidden />;
}

/** Accessible loading, error (with Retry), or empty panel fallback for page sections. */
export function SectionState({
  loading,
  error,
  onRetry,
  loadingText = 'Loading…',
  emptyText = 'Nothing to show yet.',
  errorPrefix = 'Could not load section',
  ariaLabel,
  style,
}: {
  loading?: boolean;
  error?: unknown;
  onRetry?: () => Promise<void>;
  loadingText?: string;
  emptyText?: string;
  errorPrefix?: string;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  const hasError = error !== undefined;
  return (
    <section
      className="panel"
      aria-label={ariaLabel}
      aria-busy={!hasError && loading ? 'true' : undefined}
      style={style}
    >
      {hasError ? (
        <p className="form-error" role="alert">
          {errorPrefix}: {errorMessage(error)}{' '}
          {onRetry && (
            <button type="button" className="btn btn-sm" onClick={() => void onRetry()}>
              Retry
            </button>
          )}
        </p>
      ) : (
        <p className="muted">{loading ? loadingText : emptyText}</p>
      )}
    </section>
  );
}
