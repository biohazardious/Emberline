/** API contracts: Dynamic AI CLI Toolchain Manager (/opt/ai-tools persistent volume). */
import { z } from 'zod';
import { TerminalInfo } from './terminals.js';
import { AgentId } from './runs.js';

export const CliInstallMethod = z.enum(['npm', 'script', 'pipx']);
export type CliInstallMethod = z.infer<typeof CliInstallMethod>;

export const CliToolStatus = z.object({
  provider: AgentId,
  label: z.string(),
  binaryName: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  binaryPath: z.string().nullable(),
  installMethod: CliInstallMethod,
  installCommand: z.string(),
  updateCommand: z.string(),
  uninstallCommand: z.string(),
  installing: z.boolean(),
  lastAction: z.enum(['install', 'update', 'uninstall']).nullable().default(null),
  lastUpdatedAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});
export type CliToolStatus = z.infer<typeof CliToolStatus>;

/** Large SDKs for non-web projects, installed by `emberline-sdk` into the runner-tools volume. */
export const SdkId = z.enum(['platformio', 'android', 'flutter', 'esp-qemu']);
export type SdkId = z.infer<typeof SdkId>;

export const SdkStatus = z.object({
  id: SdkId,
  label: z.string(),
  description: z.string(),
  /** Rough download and disk footprint, for the UI. */
  sizeHint: z.string(),
  installed: z.boolean(),
  /** Version recorded by the last successful install, or null. */
  version: z.string().nullable(),
  /** True while an install, update or uninstall session for it is still running in the runner. */
  installing: z.boolean(),
  /** The runner terminal of the last action, if it still exists. */
  terminalId: z.string().nullable().default(null),
});
export type SdkStatus = z.infer<typeof SdkStatus>;

export const ToolchainStatusResponse = z.object({
  toolsDir: z.string(),
  osInfo: z.string(),
  nodeVersion: z.string(),
  autoInstallEnabled: z.boolean().default(true),
  tools: z.array(CliToolStatus),
  sdks: z.array(SdkStatus).default([]),
});
export type ToolchainStatusResponse = z.infer<typeof ToolchainStatusResponse>;

export const ToolchainActionBody = z.object({
  action: z.enum(['install', 'update', 'uninstall']).default('install'),
  spawnTerminal: z.boolean().default(false),
  customCommand: z.string().trim().max(1000).optional(),
});
export type ToolchainActionBody = z.input<typeof ToolchainActionBody>;

export const ToolchainActionResponse = z.object({
  tool: CliToolStatus,
  output: z.string(),
  terminal: TerminalInfo.nullable().default(null),
});
export type ToolchainActionResponse = z.infer<typeof ToolchainActionResponse>;

export const SdkActionBody = z.object({
  action: z.enum(['install', 'update', 'uninstall']).default('install'),
});
export type SdkActionBody = z.input<typeof SdkActionBody>;

/** SDK actions take minutes, so they always run in a runner terminal the UI can follow. */
export const SdkActionResponse = z.object({
  sdk: SdkStatus,
  terminal: TerminalInfo,
});
export type SdkActionResponse = z.infer<typeof SdkActionResponse>;
