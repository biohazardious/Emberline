import { useScheduler } from '../../hooks/liveData';
import { QuotaPanel } from '../QuotaPanel';
import { SectionState } from '../SectionState';

export function QuotaSection() {
  const { scheduler, loading, error, refresh } = useScheduler();
  if (!scheduler) {
    return (
      <SectionState
        loading={loading}
        error={error}
        onRetry={refresh}
        loadingText="Loading quota & concurrency telemetry…"
        emptyText="No quota scheduler state available."
        errorPrefix="Could not load quota scheduler"
        ariaLabel="Quota scheduler"
      />
    );
  }
  return <QuotaPanel />;
}
