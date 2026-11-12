import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { ViewErrorBanner, ViewLoadingState } from './ErrorBoundary';

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
  onRetry?: () => void | Promise<void>;
  loadingText?: string;
  emptyText?: string;
  errorPrefix?: string;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  if (error !== undefined && error !== null) {
    return <ViewErrorBanner label={errorPrefix} error={error} onRetry={onRetry} />;
  }
  return (
    <section className="panel" aria-label={ariaLabel} style={style}>
      {loading ? <ViewLoadingState label={loadingText} compact /> : <p className="muted">{emptyText}</p>}
    </section>
  );
}
