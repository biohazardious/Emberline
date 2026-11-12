import {
  type AgentId,
  type FactorySettings,
  PROVIDER_REGISTRY,
  type ProviderLoginResponse,
  type ToolchainActionResponse,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';

export interface UseToolchainStateParams {
  activeTab: string;
  settings: FactorySettings | null;
  setSettings: Dispatch<SetStateAction<FactorySettings | null>>;
  setEnabledProviders: Dispatch<SetStateAction<AgentId[]>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  onNavigate: (path: string) => void;
}

export function useToolchainState({
  activeTab,
  settings,
  setSettings,
  setEnabledProviders,
  setNotice,
  setError,
  onNavigate,
}: UseToolchainStateParams) {
  const [toolchain, setToolchain] = useState<ToolchainStatusResponse | null>(null);
  const [busyToolProvider, setBusyToolProvider] = useState<AgentId | null>(null);
  const [updatingAllTools, setUpdatingAllTools] = useState(false);
  const [launchingLoginProvider, setLaunchingLoginProvider] = useState<AgentId | null>(null);

  const refreshToolchain = useCallback(async () => {
    try {
      const res = await api<ToolchainStatusResponse>('/api/toolchain/status');
      setToolchain(res);
    } catch {
      // ignore background poll errors
    }
  }, []);

  useEffect(() => {
    void refreshToolchain();
  }, [refreshToolchain]);

  useEffect(() => {
    const anyInstalling =
      (toolchain?.tools.some((t) => t.installing) ?? false) ||
      (toolchain?.sdks.some((s) => s.installing) ?? false);
    if (!anyInstalling && activeTab !== 'providers') return;
    const interval = setInterval(
      () => {
        void refreshToolchain();
      },
      anyInstalling ? 2500 : 8000,
    );
    return () => clearInterval(interval);
  }, [toolchain, activeTab, refreshToolchain]);

  const handleToolchainAction = async (
    providerId: AgentId,
    action: 'install' | 'update' | 'uninstall',
    spawnTerminal = false,
  ) => {
    setBusyToolProvider(providerId);
    setNotice(null);
    setError(null);
    try {
      const res = await api<ToolchainActionResponse>(`/api/toolchain/${providerId}/action`, 'POST', {
        action,
        spawnTerminal,
      });
      await refreshToolchain();
      if (res.terminal) {
        onNavigate(`/terminals/${res.terminal.id}`);
        return;
      }
      setNotice(
        `${PROVIDER_REGISTRY[providerId].label} CLI ${action} completed${res.tool.version ? ` (${res.tool.version})` : ''}.`,
      );
    } catch (err) {
      setError(errorMessage(err));
      await refreshToolchain();
    } finally {
      setBusyToolProvider(null);
    }
  };

  const handleUpdateAllTools = async () => {
    setUpdatingAllTools(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api<{
        updated: AgentId[];
        errors: Record<string, string>;
        status: ToolchainStatusResponse;
      }>('/api/toolchain/update-all', 'POST', {});
      setToolchain(res.status);
      const errCount = Object.keys(res.errors).length;
      if (errCount > 0) {
        setError(`Updated ${res.updated.length} CLI(s), ${errCount} failed.`);
      } else {
        setNotice(`Updated ${res.updated.length} active/installed AI CLI(s) in ${res.status.toolsDir}.`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUpdatingAllTools(false);
    }
  };

  const handleStartProviderLogin = async (providerId: AgentId) => {
    setLaunchingLoginProvider(providerId);
    setNotice(null);
    setError(null);
    try {
      // Signing in enables the provider, which the server allows for Antigravity only once the risk is accepted.
      if (providerId === 'antigravity' && !settings?.antigravityTermsAcknowledged) {
        const updated = await api<FactorySettings>('/api/factory/settings', 'PATCH', {
          antigravityTermsAcknowledged: true,
        });
        setSettings(updated);
      }
      const res = await api<ProviderLoginResponse>('/api/factory/provider-login', 'POST', {
        provider: providerId,
      });
      setEnabledProviders((prev) => (prev.includes(providerId) ? prev : [...prev, providerId]));
      onNavigate(`/terminals/${res.terminal.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLaunchingLoginProvider(null);
    }
  };

  return {
    toolchain,
    busyToolProvider,
    updatingAllTools,
    launchingLoginProvider,
    refreshToolchain,
    handleToolchainAction,
    handleUpdateAllTools,
    handleStartProviderLogin,
  };
}
