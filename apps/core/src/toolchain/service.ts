import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentId,
  type CliInstallMethod,
  type CliToolStatus,
  PROVIDER_REGISTRY,
  type TerminalInfo,
  type ToolchainActionBody,
  type ToolchainActionResponse,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import type { Db } from '../db/index.js';
import { getFactorySettings } from '../factory/service.js';
import type { PtydBridge } from '../ptyd-bridge.js';

const execFileAsync = promisify(execFile);

interface ToolSpec {
  provider: AgentId;
  binaryName: string;
  installMethod: CliInstallMethod;
  npmPackage?: string;
  installCommand: string;
  updateCommand: string;
  uninstallCommand: string;
}

const TOOL_SPECS: Record<AgentId, ToolSpec> = {
  claude: {
    provider: 'claude',
    binaryName: 'claude',
    installMethod: 'npm',
    npmPackage: '@anthropic-ai/claude-code',
    installCommand: 'npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest',
    updateCommand: 'npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest',
    uninstallCommand: 'npm uninstall -g @anthropic-ai/claude-code',
  },
  antigravity: {
    provider: 'antigravity',
    binaryName: 'agy',
    installMethod: 'script',
    installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /opt/ai-tools/bin',
    updateCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /opt/ai-tools/bin',
    uninstallCommand: 'rm -f /opt/ai-tools/bin/agy',
  },
  gemini: {
    provider: 'gemini',
    binaryName: 'gemini',
    installMethod: 'npm',
    npmPackage: '@google/gemini-cli',
    installCommand: 'npm install -g --allow-scripts=@google/gemini-cli @google/gemini-cli@latest',
    updateCommand: 'npm install -g --allow-scripts=@google/gemini-cli @google/gemini-cli@latest',
    uninstallCommand: 'npm uninstall -g @google/gemini-cli',
  },
  codex: {
    provider: 'codex',
    binaryName: 'codex',
    installMethod: 'npm',
    npmPackage: '@openai/codex',
    installCommand: 'npm install -g --allow-scripts=@openai/codex @openai/codex@latest',
    updateCommand: 'npm install -g --allow-scripts=@openai/codex @openai/codex@latest',
    uninstallCommand: 'npm uninstall -g @openai/codex',
  },
  copilot: {
    provider: 'copilot',
    binaryName: 'copilot',
    installMethod: 'npm',
    npmPackage: '@github/copilot',
    installCommand: 'npm install -g --allow-scripts=@github/copilot @github/copilot@latest',
    updateCommand: 'npm install -g --allow-scripts=@github/copilot @github/copilot@latest',
    uninstallCommand: 'npm uninstall -g @github/copilot',
  },
  aider: {
    provider: 'aider',
    binaryName: 'aider',
    installMethod: 'pipx',
    installCommand: 'pipx install --force aider-chat',
    updateCommand: 'pipx upgrade aider-chat || pipx install --force aider-chat',
    uninstallCommand: 'pipx uninstall aider-chat',
  },
};

interface ToolRuntimeState {
  installing: boolean;
  lastAction: 'install' | 'update' | 'uninstall' | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
  cachedVersion: string | null;
}

export class ToolchainService {
  private readonly toolsDir: string;
  private readonly state = new Map<AgentId, ToolRuntimeState>();

  constructor(
    private readonly db: Db,
    private readonly ptyd: PtydBridge,
    private readonly workspacesDir: string,
  ) {
    this.toolsDir = process.env.EMBERLINE_TOOLS_DIR ?? '/opt/ai-tools';
    for (const id of Object.keys(TOOL_SPECS) as AgentId[]) {
      this.state.set(id, {
        installing: false,
        lastAction: null,
        lastUpdatedAt: null,
        lastError: null,
        cachedVersion: null,
      });
    }
  }

  private getToolEnv(): NodeJS.ProcessEnv {
    const toolsDir = this.toolsDir;
    return {
      ...process.env,
      HOME: path.join(toolsDir, 'home'),
      EMBERLINE_TOOLS_DIR: toolsDir,
      NPM_CONFIG_PREFIX: path.join(toolsDir, 'npm'),
      NPM_CONFIG_CACHE: path.join(toolsDir, 'npm-cache'),
      PIPX_HOME: path.join(toolsDir, 'pipx'),
      PIPX_BIN_DIR: path.join(toolsDir, 'bin'),
      PATH: `${path.join(toolsDir, 'bin')}:${path.join(toolsDir, 'npm', 'bin')}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    };
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(path.join(this.toolsDir, 'home'), { recursive: true }).catch(() => {});
    await mkdir(path.join(this.toolsDir, 'bin'), { recursive: true }).catch(() => {});
    await mkdir(path.join(this.toolsDir, 'npm', 'bin'), { recursive: true }).catch(() => {});
    await mkdir(path.join(this.toolsDir, 'npm', 'lib'), { recursive: true }).catch(() => {});
    await mkdir(path.join(this.toolsDir, 'npm-cache'), { recursive: true }).catch(() => {});
    await mkdir(path.join(this.toolsDir, 'pipx'), { recursive: true }).catch(() => {});
  }

  private readOsInfo(): string {
    try {
      if (existsSync('/etc/os-release')) {
        const raw = readFileSync('/etc/os-release', 'utf8');
        const match = raw.match(/^PRETTY_NAME="([^"]+)"/m);
        if (match?.[1]) return match[1];
      }
    } catch {
      // ignore
    }
    return `Linux (${process.arch})`;
  }

  private resolveBinaryPath(spec: ToolSpec): string | null {
    const candidates =
      spec.installMethod === 'npm'
        ? [
            path.join(this.toolsDir, 'npm', 'bin', spec.binaryName),
            path.join(this.toolsDir, 'bin', spec.binaryName),
          ]
        : [
            path.join(this.toolsDir, 'bin', spec.binaryName),
            path.join(this.toolsDir, 'npm', 'bin', spec.binaryName),
          ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private async detectVersion(spec: ToolSpec, binaryPath: string | null): Promise<string | null> {
    if (!binaryPath) return null;

    // Fast path for npm global packages: read package.json in /opt/ai-tools/npm/lib/node_modules/<pkg>
    if (spec.npmPackage) {
      const pkgJsonPath = path.join(this.toolsDir, 'npm', 'lib', 'node_modules', spec.npmPackage, 'package.json');
      if (existsSync(pkgJsonPath)) {
        try {
          const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string };
          if (typeof parsed.version === 'string' && parsed.version.trim()) {
            return parsed.version.trim();
          }
        } catch {
          // fallback to --version
        }
      }
    }

    const rt = this.state.get(spec.provider);
    if (rt?.cachedVersion) return rt.cachedVersion;

    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
        timeout: 4_000,
        env: this.getToolEnv(),
      });
      const combined = `${stdout}\n${stderr}`.trim();
      const firstLine = combined.split('\n')[0]?.trim() ?? '';
      const versionMatch = firstLine.match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
      const detected = versionMatch ? versionMatch[0] : firstLine.slice(0, 48) || 'installed';
      if (rt) rt.cachedVersion = detected;
      return detected;
    } catch {
      return 'installed';
    }
  }

  async getToolStatus(provider: AgentId): Promise<CliToolStatus> {
    const spec = TOOL_SPECS[provider];
    const entry = PROVIDER_REGISTRY[provider];
    const rt = this.state.get(provider)!;
    const binaryPath = this.resolveBinaryPath(spec);
    const installed = Boolean(binaryPath);
    const version = installed ? await this.detectVersion(spec, binaryPath) : null;

    return {
      provider,
      label: entry.label,
      binaryName: spec.binaryName,
      installed,
      version,
      binaryPath,
      installMethod: spec.installMethod,
      installCommand: spec.installCommand,
      updateCommand: spec.updateCommand,
      uninstallCommand: spec.uninstallCommand,
      installing: rt.installing,
      lastAction: rt.lastAction,
      lastUpdatedAt: rt.lastUpdatedAt,
      lastError: rt.lastError,
    };
  }

  async getStatus(): Promise<ToolchainStatusResponse> {
    const providers = Object.keys(TOOL_SPECS) as AgentId[];
    const tools = await Promise.all(providers.map((p) => this.getToolStatus(p)));
    return {
      toolsDir: this.toolsDir,
      osInfo: this.readOsInfo(),
      nodeVersion: process.version,
      autoInstallEnabled: true,
      tools,
    };
  }

  async executeAction(
    provider: AgentId,
    rawBody: ToolchainActionBody,
  ): Promise<ToolchainActionResponse> {
    const spec = TOOL_SPECS[provider];
    const entry = PROVIDER_REGISTRY[provider];
    const rt = this.state.get(provider)!;
    const action = rawBody.action ?? 'install';

    await this.ensureDirs();

    const defaultCmd =
      action === 'uninstall'
        ? spec.uninstallCommand
        : action === 'update'
          ? spec.updateCommand
          : spec.installCommand;
    const commandToRun = rawBody.customCommand?.trim() || defaultCmd;

    if (rawBody.spawnTerminal) {
      const envSetup = [
        `export EMBERLINE_TOOLS_DIR="${this.toolsDir}"`,
        `export NPM_CONFIG_PREFIX="${path.join(this.toolsDir, 'npm')}"`,
        `export PIPX_HOME="${path.join(this.toolsDir, 'pipx')}"`,
        `export PIPX_BIN_DIR="${path.join(this.toolsDir, 'bin')}"`,
        `export PATH="${path.join(this.toolsDir, 'bin')}:${path.join(this.toolsDir, 'npm', 'bin')}:$PATH"`,
      ].join('; ');

      const shellScript = [
        envSetup,
        `printf "\\033[1;36m=== 📦 ${entry.icon} ${entry.label} — CLI ${action.toUpperCase()} ===\\033[0m\\n"`,
        `printf "\\033[0;90mTarget volume: ${this.toolsDir}\\nCommand: ${commandToRun.replace(/"/g, '\\"')}\\033[0m\\n\\n"`,
        commandToRun,
        `STATUS=$?`,
        `if [ $STATUS -eq 0 ]; then printf "\\n\\033[1;32m✓ ${entry.shortLabel} CLI ${action} completed successfully.\\033[0m\\n"; else printf "\\n\\033[1;31m✗ ${entry.shortLabel} CLI ${action} exited with code $STATUS.\\033[0m\\n"; fi`,
        `exec bash -i`,
      ].join('; ');

      const session = await this.ptyd.get().spawn({
        file: 'bash',
        args: ['-c', shellScript],
        cwd: this.workspacesDir,
        meta: {
          kind: 'shell',
          title: `📦 ${action === 'update' ? 'Update' : 'Install'} · ${entry.shortLabel}`,
        },
      });

      rt.cachedVersion = null;
      rt.lastAction = action;
      rt.lastUpdatedAt = new Date().toISOString();

      const terminalInfo: TerminalInfo = {
        id: session.id,
        title: session.meta.title ?? `📦 ${entry.shortLabel}`,
        kind: 'shell',
        projectId: null,
        runId: null,
        status: session.status,
        exitCode: session.exitCode,
        createdAt: session.createdAt,
      };

      return {
        tool: await this.getToolStatus(provider),
        output: `Spawned interactive terminal for: ${commandToRun}`,
        terminal: terminalInfo,
      };
    }

    rt.installing = true;
    rt.lastAction = action;
    rt.lastError = null;
    rt.cachedVersion = null;

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', commandToRun], {
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
        env: this.getToolEnv(),
      });
      rt.installing = false;
      rt.lastUpdatedAt = new Date().toISOString();
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return {
        tool: await this.getToolStatus(provider),
        output: output || `${entry.shortLabel} CLI ${action} completed.`,
        terminal: null,
      };
    } catch (err) {
      rt.installing = false;
      const execErr = err as Error & { stdout?: string; stderr?: string };
      const details = [execErr.stderr?.trim(), execErr.stdout?.trim(), execErr.message]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000);
      rt.lastError = details;
      throw new Error(`CLI ${action} failed for ${entry.label}: ${details}`);
    }
  }

  async updateAllInstalled(): Promise<{ updated: AgentId[]; errors: Record<string, string> }> {
    const status = await this.getStatus();
    const settings = getFactorySettings(this.db);
    const targets = status.tools.filter(
      (t) => t.installed || settings.enabledProviders.includes(t.provider),
    );
    const updated: AgentId[] = [];
    const errors: Record<string, string> = {};

    for (const t of targets) {
      try {
        await this.executeAction(t.provider, {
          action: t.installed ? 'update' : 'install',
          spawnTerminal: false,
        });
        updated.push(t.provider);
      } catch (err) {
        errors[t.provider] = (err as Error).message;
      }
    }
    return { updated, errors };
  }

  /**
   * Ensures all enabled providers from FactorySettings have their CLI installed in `/opt/ai-tools`.
   * Runs non-blockingly in the background on production startup and when providers are enabled.
   */
  ensureEnabledProvidersInstalled(providers?: AgentId[]): void {
    const enabled = providers ?? getFactorySettings(this.db).enabledProviders;
    void (async () => {
      await this.ensureDirs();
      for (const provider of enabled) {
        const spec = TOOL_SPECS[provider];
        if (!spec) continue;
        const rt = this.state.get(provider);
        if (rt?.installing) continue;
        const binaryPath = this.resolveBinaryPath(spec);
        if (!binaryPath) {
          try {
            await this.executeAction(provider, { action: 'install', spawnTerminal: false });
          } catch {
            // Recorded in rt.lastError for UI display
          }
        }
      }
    })();
  }
}
