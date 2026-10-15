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

export const ToolchainStatusResponse = z.object({
  toolsDir: z.string(),
  osInfo: z.string(),
  nodeVersion: z.string(),
  autoInstallEnabled: z.boolean().default(true),
  tools: z.array(CliToolStatus),
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
