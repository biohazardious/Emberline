import { useSshKeys } from '../../hooks/useSettingsQueries';
import { SectionState } from '../SectionState';
import { SshKeyPanel } from '../SshKeyPanel';

export function SshKeySection() {
  const { shared } = useSshKeys();
  if (!shared.data) {
    return (
      <SectionState
        loading={shared.loading}
        error={shared.error}
        onRetry={shared.refresh}
        loadingText="Loading SSH key & trusted hosts…"
        emptyText="No SSH key configured yet."
        errorPrefix="Could not load SSH key"
        ariaLabel="SSH key"
      />
    );
  }
  return <SshKeyPanel />;
}
