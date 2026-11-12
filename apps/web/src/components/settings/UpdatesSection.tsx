import { useUpdatesStatus } from '../../hooks/useSettingsQueries';
import { SectionState } from '../SectionState';
import { UpdatesPanel } from '../UpdatesPanel';

export function UpdatesSection() {
  const query = useUpdatesStatus();
  if (!query.data) {
    return (
      <SectionState
        loading={query.loading}
        error={query.error}
        onRetry={query.refresh}
        loadingText="Loading update status…"
        emptyText="No update information available yet."
        errorPrefix="Could not load update status"
        ariaLabel="Updates"
      />
    );
  }
  return <UpdatesPanel />;
}
