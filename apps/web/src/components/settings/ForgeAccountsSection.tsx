import { useForgeAccounts } from '../../hooks/useSettingsQueries';
import { ForgeAccountsPanel } from '../ForgeAccountsPanel';
import { NotificationsPanel } from '../NotificationsPanel';
import { SectionState } from '../SectionState';
import './settings-panels.css';

export function ForgeAccountsSection() {
  const list = useForgeAccounts();
  if (!list.data) {
    return (
      <div className="settings-stack">
        <SectionState
          loading={list.loading}
          error={list.error}
          onRetry={list.refresh}
          loadingText="Loading forge accounts…"
          emptyText="No forge accounts yet."
          errorPrefix="Could not load forge accounts"
          ariaLabel="Forge accounts"
        />
        <NotificationsPanel />
      </div>
    );
  }
  return (
    <div className="settings-stack">
      <ForgeAccountsPanel />
      <NotificationsPanel />
    </div>
  );
}
