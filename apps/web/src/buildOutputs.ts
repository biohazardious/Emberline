import type { ProjectBuildOutput } from '@emberline/protocol';

export type OutputGroup = 'android' | 'installer' | 'firmware' | 'other';
export type OutputGroupFilter = OutputGroup | 'all';

export const OUTPUT_GROUPS: { id: OutputGroupFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'android', label: 'APK / AAB' },
  { id: 'installer', label: 'Installers' },
  { id: 'firmware', label: 'Firmware' },
  { id: 'other', label: 'Other' },
];

const GROUP_BY_EXTENSION: Record<string, OutputGroup> = {
  '.apk': 'android',
  '.aab': 'android',
  '.ipa': 'installer',
  '.appimage': 'installer',
  '.deb': 'installer',
  '.rpm': 'installer',
  '.snap': 'installer',
  '.flatpak': 'installer',
  '.exe': 'installer',
  '.msi': 'installer',
  '.dmg': 'installer',
  '.pkg': 'installer',
  '.elf': 'firmware',
  '.hex': 'firmware',
  '.uf2': 'firmware',
  '.bin': 'firmware',
};

/** The filter chip a file belongs to, from its extension. */
export function outputGroup(name: string): OutputGroup {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'other';
  return GROUP_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? 'other';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  // Rounding 1023.96 KB to one decimal gives 1024.0, which belongs in the next unit.
  while ((value >= 1024 || Number(value.toFixed(1)) >= 1024) && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Quota sizes read better without a trailing ".0" ("5 GB", "512 MB"). */
function formatQuota(bytes: number): string {
  return formatBytes(bytes).replace(/\.0 /, ' ');
}

export function usageText(usedBytes: number, quotaBytes: number): string {
  return `${formatBytes(usedBytes)} of ${formatQuota(quotaBytes)}`;
}

/** Share of the quota in use for the bar, 0..1. */
export function usageFraction(usedBytes: number, quotaBytes: number): number {
  if (!(quotaBytes > 0)) return 0;
  return Math.max(0, Math.min(1, usedBytes / quotaBytes));
}

export interface OutputFilter {
  group: OutputGroupFilter;
  query: string;
  runId: string | null;
}

export function filterOutputs(outputs: ProjectBuildOutput[], filter: OutputFilter): ProjectBuildOutput[] {
  const q = filter.query.trim().toLowerCase();
  return outputs.filter((o) => {
    if (filter.runId && o.runId !== filter.runId) return false;
    if (filter.group !== 'all' && outputGroup(o.name) !== filter.group) return false;
    if (!q) return true;
    return [o.name, o.ticketKey, o.ticketTitle].some((v) => v?.toLowerCase().includes(q));
  });
}

/** The quota field as GB between 0.5 and 1000 (anything unreadable counts as the 5 GB default). */
export function clampQuotaGb(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) return 5;
  return Math.max(0.5, Math.min(1000, n));
}

/** Fleet badge: where it links and what it says; null when the run has no outputs. */
export function outputsBadge(projectId: string, runId: string, count: number): { href: string; label: string } | null {
  if (count <= 0) return null;
  return {
    href: `/projects/${encodeURIComponent(projectId)}/outputs?run=${encodeURIComponent(runId)}`,
    label: `${count} ${count === 1 ? 'output' : 'outputs'}`,
  };
}
