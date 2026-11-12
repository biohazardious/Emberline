import type {
  ClaudeUsageTelemetry,
  ForgeAccountsResponse,
  SshKeyResponse,
  ToolchainStatusResponse,
  TrustedHostKeysResponse,
  UpdatesResponse,
} from '@emberline/protocol';
import { useApi } from './useApi';

/**
 * Persistent CLI & SDK toolchain status in `/opt/ai-tools`. Polls every 2.5 s while a CLI or SDK
 * install is running, every 8 s while `active` (Providers tab open), and pauses otherwise.
 */
export function useToolchainStatus(active: boolean) {
  return useApi<ToolchainStatusResponse>('/api/toolchain/status', (data) => {
    const installing =
      (data?.tools.some((t) => t.installing) ?? false) || (data?.sdks.some((s) => s.installing) ?? false);
    return installing ? 2_500 : active ? 8_000 : false;
  });
}

/** Claude OAuth & local CLI usage telemetry, shared between Providers and Quota sections. */
export function useClaudeUsage(intervalMs = 30_000) {
  return useApi<ClaudeUsageTelemetry>('/api/factory/claude-usage', intervalMs);
}

/** Configured GitHub, GitLab and Gitea forge accounts. */
export function useForgeAccounts(intervalMs = 60_000) {
  return useApi<ForgeAccountsResponse>('/api/forge/accounts', intervalMs);
}

/** Shared SSH public key and trusted SSH host keys. */
export function useSshKeys(intervalMs = 60_000) {
  const shared = useApi<SshKeyResponse>('/api/ssh-key', intervalMs);
  const hosts = useApi<TrustedHostKeysResponse>('/api/ssh-host-keys', intervalMs);
  return { shared, hosts };
}

/** Release & CLI/MCP update status. */
export function useUpdatesStatus(intervalMs = 60_000) {
  return useApi<UpdatesResponse>('/api/updates', intervalMs);
}
