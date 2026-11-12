import { AccountPanel } from '../AccountPanel';
import { SectionState } from '../SectionState';

export function AccountSection({
  loading,
  error,
  empty,
  onRetry,
}: {
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  onRetry?: () => Promise<void>;
}) {
  if (loading || error !== undefined || empty) {
    return (
      <SectionState
        loading={loading}
        error={error}
        onRetry={onRetry}
        loadingText="Loading account settings…"
        emptyText="Account settings are not available."
        errorPrefix="Could not load account settings"
        ariaLabel="Admin password"
      />
    );
  }
  return <AccountPanel />;
}
