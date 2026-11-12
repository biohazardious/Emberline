import type { FactorySettings } from '@emberline/protocol';
import { useApi } from './useApi';

/** Factory settings query shared across Settings, Roadmap and Quota views. */
export function useFactorySettings(intervalMs: number | false = 20_000) {
  return useApi<FactorySettings>('/api/factory/settings', intervalMs);
}
