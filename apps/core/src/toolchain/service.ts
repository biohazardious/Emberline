import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '@emberline/adapter-claude';
import {
  type AgentId,
  type CliInstallMethod,
  type CliToolStatus,
  PROVIDER_REGISTRY,
  type SdkActionBody,
  type SdkActionResponse,
  type SdkId,
  type SdkStatus,
  type TerminalInfo,
  type ToolchainActionBody,
  type ToolchainActionResponse,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import type { Db } from '../db/index.js';
import { conflict } from '../errors.js';
import { getFactorySettings } from '../factory/service.js';
import type { PtydBridge } from '../ptyd-bridge.js';

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
    // aider-chat does not support the runner's Python (3.14); pipx fetches a standalone 3.12.
    installCommand: 'pipx install --force --python 3.12 --fetch-missing-python aider-chat',
    updateCommand: 'pipx upgrade aider-chat || pipx install --force --python 3.12 --fetch-missing-python aider-chat',
    uninstallCommand: 'pipx uninstall aider-chat',
  },
};

const SDK_SPECS: Record<SdkId, Pick<SdkStatus, 'label' | 'description' | 'sizeHint'>> = {
  platformio: {
    label: 'PlatformIO',
    description: 'Firmware builds, uploads and serial monitor for ESP32, Arduino, STM32 and RP2040 (pio).',
    sizeHint: '~100 MB, plus each board platform on first build',
  },
  android: {
    label: 'Android SDK + JDK 21',
    description: 'APK builds for Android, Capacitor, React Native / Expo and Flutter projects (gradle, adb).',
    sizeHint: '~800 MB; Gradle adds the NDK and other platforms on demand (up to ~3 GB)',
  },
  flutter: {
    label: 'Flutter',
    description: 'Flutter and Dart for web, Linux desktop and (with the Android SDK) APK builds.',
    sizeHint: '~2.5 GB',
  },
  'esp-qemu': {
    label: 'ESP32 QEMU',
    description: "Espressif's QEMU: run, flash and read ESP32 / ESP32-S3 / ESP32-C3 firmware without a board.",
    sizeHint: '~150 MB',
  },
};

/** Where each CLI is published, for update checks: its npm package or PyPI project. */
export const CLI_PACKAGES: Record<AgentId, { npm?: string; pypi?: string }> = Object.fromEntries(
  (Object.keys(TOOL_SPECS) as AgentId[]).map((id) => [
    id,
    TOOL_SPECS[id].npmPackage ? { npm: TOOL_SPECS[id].npmPackage } : id === 'aider' ? { pypi: 'aider-chat' } : {},
  ]),
) as Record<AgentId, { npm?: string; pypi?: string }>;

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
  /** Runner terminal of each SDK's last action. */
  private readonly sdkTerminals = new Map<SdkId, string>();
  private readonly sdkCommand = process.env.EMBERLINE_SDK_COMMAND ?? 'emberline-sdk';

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

  /** Exports that point npm/pipx at the persistent runner-tools volume. */
  private toolsEnvSetup(): string {
    return [
      `mkdir -p "${this.toolsDir}/bin" "${this.toolsDir}/npm/bin" "${this.toolsDir}/npm/lib" "${this.toolsDir}/pipx"`,
      `export EMBERLINE_TOOLS_DIR="${this.toolsDir}"`,
      `export NPM_CONFIG_PREFIX="${path.join(this.toolsDir, 'npm')}"`,
      `export PIPX_HOME="${path.join(this.toolsDir, 'pipx')}"`,
      `export PIPX_BIN_DIR="${path.join(this.toolsDir, 'bin')}"`,
      `export PATH="${path.join(this.toolsDir, 'bin')}:${path.join(this.toolsDir, 'npm', 'bin')}:$PATH"`,
    ].join('; ');
  }

  /**
   * Runs a shell script in the runner (through ptyd) and waits for it to exit. Core never executes
   * anything from the runner-tools volume itself: agents can write there, and core holds the
   * database, tokens and API keys.
   */
  private async runInRunner(script: string, title: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
    const client = this.ptyd.get();
    const session = await client.spawn({
      file: 'bash',
      args: ['-c', script],
      cwd: this.workspacesDir,
      cols: 200,
      meta: { kind: 'shell', title },
    });
    const deadline = Date.now() + timeoutMs;
    try {
      let exitCode: number | null = null;
      for (;;) {
        const info = (await client.list()).sessions.find((s) => s.id === session.id);
        if (!info || info.status === 'exited') {
          exitCode = info?.exitCode ?? null;
          break;
        }
        if (Date.now() > deadline) {
          await client.kill(session.id).catch(() => undefined);
          throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      const snapshot = await client.snapshot(session.id, 2_000).catch(() => null);
      return { exitCode, output: stripAnsi(snapshot?.data ?? '').trim() };
    } finally {
      await client.remove(session.id).catch(() => undefined);
    }
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

    // Never execute the binary from core (see runInRunner).
    return 'installed';
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
      sdks: await this.getSdkStatuses(),
    };
  }

  /** Reads the version marker `emberline-sdk` writes after a successful install (read-only mount). */
  private readSdkVersion(id: SdkId): string | null {
    try {
      const raw = readFileSync(path.join(this.toolsDir, 'sdk', '.installed', id), 'utf8').trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  async getSdkStatuses(): Promise<SdkStatus[]> {
    const sessions = this.ptyd.status === 'connected' ? (await this.ptyd.get().list()).sessions : [];
    return (Object.keys(SDK_SPECS) as SdkId[]).map((id) => {
      const terminalId = this.sdkTerminals.get(id) ?? null;
      const session = terminalId ? sessions.find((s) => s.id === terminalId) : undefined;
      const version = this.readSdkVersion(id);
      return {
        id,
        ...SDK_SPECS[id],
        installed: version !== null,
        version,
        installing: session?.status === 'running',
        terminalId: session ? terminalId : null,
      };
    });
  }

  /**
   * Runs `emberline-sdk <action> <id>` in a runner terminal and returns right away: downloads take
   * minutes, and the UI follows the terminal. Only one SDK or CLI action runs at a time.
   */
  async executeSdkAction(id: SdkId, body: SdkActionBody): Promise<SdkActionResponse> {
    const action = body.action ?? 'install';
    const busyCli = [...this.state.entries()].find(([, state]) => state.installing);
    if (busyCli) throw conflict(`${PROVIDER_REGISTRY[busyCli[0]].label} CLI install is still running; wait for it to finish`);
    const busySdk = (await this.getSdkStatuses()).find((sdk) => sdk.installing);
    if (busySdk) throw conflict(`${busySdk.label} ${action} is still running; wait for it to finish`);

    const label = SDK_SPECS[id].label;
    const script = [
      `${this.sdkCommand} ${action} ${id}`,
      'STATUS=$?',
      `if [ $STATUS -eq 0 ]; then printf "\\n\\033[1;32m✓ ${label} ${action} finished.\\033[0m\\n"; else printf "\\n\\033[1;31m✗ ${label} ${action} failed (exit $STATUS).\\033[0m\\n"; fi`,
      'exit $STATUS',
    ].join('\n');
    const session = await this.ptyd.get().spawn({
      file: 'bash',
      args: ['-c', script],
      cwd: this.workspacesDir,
      cols: 160,
      meta: { kind: 'shell', title: `SDK ${action} · ${label}` },
    });
    this.sdkTerminals.set(id, session.id);
    const sdk = (await this.getSdkStatuses()).find((s) => s.id === id)!;
    return {
      sdk,
      terminal: {
        id: session.id,
        title: session.meta.title ?? `SDK ${action} · ${label}`,
        kind: 'shell',
        projectId: null,
        runId: null,
        status: session.status,
        exitCode: session.exitCode,
        createdAt: session.createdAt,
      },
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
    // B24: every CLI installs into the same npm/pipx prefix on the runner-tools volume, so two
    // installs at once (even for different providers) can corrupt it. One at a time, globally.
    const busy = [...this.state.entries()].find(([, state]) => state.installing);
    if (busy) {
      const [busyProvider, busyState] = busy;
      throw conflict(
        `${PROVIDER_REGISTRY[busyProvider].label} CLI ${busyState.lastAction ?? 'install'} is still running; wait for it to finish`,
      );
    }

    const defaultCmd =
      action === 'uninstall'
        ? spec.uninstallCommand
        : action === 'update'
          ? spec.updateCommand
          : spec.installCommand;
    const commandToRun = rawBody.customCommand?.trim() || defaultCmd;

    if (rawBody.spawnTerminal) {
      const envSetup = this.toolsEnvSetup();

      const shellScript = [
        envSetup,
        `printf "\\033[1;36m=== ${entry.label} — CLI ${action.toUpperCase()} ===\\033[0m\\n"`,
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
      const { exitCode, output } = await this.runInRunner(
        `${this.toolsEnvSetup()}; ${commandToRun}`,
        `📦 ${action === 'update' ? 'Update' : 'Install'} · ${entry.shortLabel}`,
        180_000,
      );
      if (exitCode !== 0) {
        throw Object.assign(new Error(`exited with code ${exitCode ?? 'unknown'}`), { stdout: output.slice(-2000) });
      }
      rt.installing = false;
      rt.lastUpdatedAt = new Date().toISOString();
      return {
        tool: await this.getToolStatus(provider),
        output: output.slice(-4000) || `${entry.shortLabel} CLI ${action} completed.`,
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
