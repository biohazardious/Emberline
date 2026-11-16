import type { AgentId } from '@emberline/protocol';
import { Flame, Globe, Scale, Wallet, Zap } from 'lucide-react';
import { ico } from '../../SectionState';
import { MoreMenu, type MoreMenuItem } from '../../ui/MoreMenu';
import type { CapabilityPreset } from '../settingsMeta';

export interface PresetMenuProps {
  enabledProviders: readonly AgentId[];
  onSelectPreset: (preset: CapabilityPreset) => void;
}

export function PresetMenu({ enabledProviders, onSelectPreset }: PresetMenuProps) {
  const items: MoreMenuItem[] = [
    {
      id: 'auto-rank',
      label: 'Auto-match by rank',
      description: 'Match each persona to its recommended ★1–5 rank',
      icon: ico(Zap),
      onSelect: () => onSelectPreset('auto-rank'),
    },
    {
      id: 'multi-provider',
      label: 'Multi-provider split',
      description: 'Distribute UI/UX, QA and architecture across enabled providers',
      icon: ico(Globe),
      disabled: enabledProviders.length <= 1,
      onSelect: () => onSelectPreset('multi-provider'),
    },
    {
      id: 'all-high',
      label: 'All high (★4–5)',
      description: 'Assign frontier and flagship models across all personas',
      icon: ico(Flame),
      onSelect: () => onSelectPreset('all-high'),
    },
    {
      id: 'all-medium',
      label: 'All medium (★3)',
      description: 'Assign balanced medium-tier models across all personas',
      icon: ico(Scale),
      onSelect: () => onSelectPreset('all-medium'),
    },
    {
      id: 'all-low',
      label: 'All low (★1–2)',
      description: 'Assign fast, low-cost models across all personas',
      icon: ico(Wallet),
      onSelect: () => onSelectPreset('all-low'),
    },
  ];

  return <MoreMenu label="Apply preset" ariaLabel="Apply preset" items={items} />;
}
