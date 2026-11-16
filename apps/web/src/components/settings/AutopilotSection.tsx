import type { FactorySettings } from '@emberline/protocol';
import type { FormEvent } from 'react';
import { SectionState } from '../SectionState';
import { SaveBar } from '../ui/SaveBar';
import { MergingAndCommitSection } from './automation/MergingAndCommitSection';
import { QueueAndGatesSection } from './automation/QueueAndGatesSection';
import './settings-sections.css';
import type { AutopilotDraft } from './settingsMeta';

export function AutopilotSection({
  settings,
  loading,
  loadError,
  onRetry,
  theme,
  onChangeTheme,
  draft,
  onChangeDraft,
  dirty = false,
  onDiscard = () => undefined,
  saving,
  onSave,
}: {
  settings: FactorySettings | undefined;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => Promise<void>;
  theme: 'dark' | 'light';
  onChangeTheme: (theme: 'dark' | 'light') => void;
  draft: AutopilotDraft;
  onChangeDraft: (patch: Partial<AutopilotDraft>) => void;
  dirty?: boolean;
  onDiscard?: () => void;
  saving: boolean;
  onSave: (e: FormEvent) => void;
}) {
  if (!settings) {
    return (
      <SectionState
        loading={loading}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading Auto-Pilot & Theme settings…"
        emptyText="No factory settings available yet."
        errorPrefix="Could not load factory settings"
      />
    );
  }

  return (
    <form onSubmit={onSave} className="panel settings-section-form">
      <QueueAndGatesSection
        theme={theme}
        onChangeTheme={onChangeTheme}
        draft={draft}
        onChangeDraft={onChangeDraft}
      />

      <MergingAndCommitSection draft={draft} onChangeDraft={onChangeDraft} />

      <SaveBar dirty={dirty} saving={saving} onDiscard={onDiscard} />
    </form>
  );
}
