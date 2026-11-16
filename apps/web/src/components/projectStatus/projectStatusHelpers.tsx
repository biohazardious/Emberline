import type {
  BuildDemoResponse,
  FactoryAttachmentInput,
  Project,
  SyncWorktreeResponse,
  WorkspaceDemoTarget,
} from '@emberline/protocol';
import { api, errorMessage } from '../../api';
import { builtLine, staleBadge } from '../../demoFreshness';
import { reviewBlockedCount, worktreeMissing } from '../../reviewComments';
import { syncWorktreeOutcome } from '../../syncResolution';
import { toastInfo } from '../../toast';

export interface DemoRuntimeError {
  message: string;
  stack?: string;
  timestamp: string;
}

export interface AttachedFilePreview extends FactoryAttachmentInput {
  id: string;
  previewDataUrl?: string;
}

export interface StatusBannerMessage {
  kind: 'ok' | 'info' | 'err';
  text: string;
  href?: string;
  linkLabel?: string;
}

export type StudioTab = 'factory' | 'demo' | 'browser' | 'worktrees' | 'checkpoints';

export function getFactoryExamples(project: Project, target?: WorkspaceDemoTarget): string[] {
  const appType = project.appType ?? 'fullstack';
  const layers = target?.detectedLayers ?? [];
  const stack = (target?.detectedStack ?? '').toLowerCase();

  if (
    appType === 'embedded_iot' ||
    layers.includes('Embedded / Hardware Firmware') ||
    stack.includes('platformio')
  ) {
    return [
      'Implement I2C and SPI bus scanner with EEPROM read/write routine and CRC verification',
      'Add non-blocking serial command CLI (115200 baud) with diagnostic status output',
      'Add PlatformIO environment targets, pinout config header, and hardware test routine',
    ];
  }

  if (appType === 'cli_tool' || layers.includes('CLI / System Automation') || stack.includes('shell')) {
    return [
      'Add --dry-run mode, pre-flight kernel checks, and automatic rollback on failure',
      'Add structured JSON log output, strict exit codes, and systemd service unit',
      'Add SHA256 artifact checksum verification and automated smoke test script',
    ];
  }

  if (appType === 'mobile_desktop' || layers.includes('Desktop / Mobile Native') || stack.includes('rust')) {
    return [
      'Add persistent JSON configuration, multi-monitor window state, and system tray controls',
      'Implement smooth hardware-accelerated rendering, keyboard shortcuts, and theme presets',
      'Add typed IPC command bridge between native backend and UI layer',
    ];
  }

  if (appType === 'ai_agents') {
    return [
      'Build multi-agent DAG task router with live SSE streaming and tool-call execution logs',
      'Add per-agent token telemetry ledger and automatic fallback circuit breaker',
      'Add interactive agent workflow inspector and customizable system prompt templates',
    ];
  }

  if (appType === 'api_service' || appType === 'library') {
    return [
      'Add OpenAPI schema validation, structured error middleware, and /healthz diagnostics',
      'Implement database migration runner, repository layer, and audit log endpoints',
      'Add comprehensive integration test suite and request rate-limiting',
    ];
  }

  if (appType === 'game_interactive') {
    return [
      'Add a live score counter and persistent high-score HUD overlay',
      'Modernize the visual design, color palette, and UI animations',
      'Add a game-over summary screen with a local leaderboard',
    ];
  }

  return [
    'Build a multi-step workflow form with validation, status tracking, and CSV/PDF export',
    'Add role-based dashboard view with filterable data grid and REST API integration',
    'Modernize UI layout, responsive navigation, dark theme polish, and error boundaries',
  ];
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function parseAttachmentFiles(
  files: FileList | File[],
  existingCount: number,
  onError: (message: string) => void,
): Promise<AttachedFilePreview[]> {
  const list = Array.from(files).slice(0, 10 - existingCount);
  const added: AttachedFilePreview[] = [];
  for (const file of list) {
    if (file.size > 15 * 1024 * 1024) {
      onError(`File "${file.name}" exceeds the 15 MB per-file limit.`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const rawBase64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(file.name);
      added.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || `pasted-image-${Date.now()}.png`,
        mimeType: file.type || 'application/octet-stream',
        dataBase64: rawBase64,
        sizeBytes: file.size,
        previewDataUrl: isImage ? dataUrl : undefined,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }
  return added;
}

export function buildRuntimeErrorPrompt(errItem: DemoRuntimeError): string {
  const stackBlock = errItem.stack ? `Stack:\n\`\`\`\n${errItem.stack.slice(0, 1200)}\n\`\`\`\n` : '';
  return `[Runtime Error Fix] The Live Demo threw the following runtime error in the browser:\n\nError: ${errItem.message}\n${stackBlock}\nPlease diagnose and fix the root cause in the codebase and rebuild the bundle.`;
}

export function isCompletedWorktreeTarget(t: WorkspaceDemoTarget): boolean {
  return t.kind === 'worktree' && (t.runStatus === 'done' || t.runStatus === 'failed');
}

export async function executeSyncWorktree({
  projectId,
  runId,
  force,
  refreshAll,
  onMerged,
  onBanner,
  onBlocked,
  onMissing,
}: {
  projectId: string;
  runId: string;
  force: boolean;
  refreshAll: () => Promise<void>;
  onMerged: () => void;
  onBanner: (msg: StatusBannerMessage) => void;
  onBlocked: (count: number) => void;
  onMissing: (ticketId: string) => void;
}): Promise<void> {
  try {
    const res = await api<SyncWorktreeResponse>(
      `/api/projects/${projectId}/sync-worktree`,
      'POST',
      force ? { runId, force: true } : { runId },
    );
    await refreshAll();
    const outcome = syncWorktreeOutcome(res);
    if (outcome.kind === 'merged') {
      onMerged();
      if (res.resolution === 'auto_resolved') toastInfo(outcome.toast);
      onBanner({ kind: 'ok', text: outcome.toast });
    } else if (outcome.kind === 'resolving') {
      onBanner({ kind: 'info', text: outcome.text, href: outcome.href, linkLabel: outcome.linkLabel });
    } else {
      onBanner({ kind: 'err', text: res.summary });
    }
  } catch (e) {
    const blocking = reviewBlockedCount(e);
    const missing = worktreeMissing(e);
    if (blocking !== null) onBlocked(blocking);
    else if (missing?.ticketId) onMissing(missing.ticketId);
    else onBanner({ kind: 'err', text: errorMessage(e) });
  }
}

export async function executeBuildDemo({
  projectId,
  target,
  refreshStatus,
  onOutput,
  onDemoBuilt,
  onBanner,
}: {
  projectId: string;
  target: WorkspaceDemoTarget;
  refreshStatus: () => Promise<void>;
  onOutput: (output: string) => void;
  onDemoBuilt: () => void;
  onBanner: (msg: StatusBannerMessage) => void;
}): Promise<void> {
  try {
    const res = await api<BuildDemoResponse>(`/api/projects/${projectId}/build-demo`, 'POST', {
      targetId: target.id,
    });
    onOutput(res.output || '');
    await refreshStatus();
    if (res.ok && res.demoUrl) {
      onDemoBuilt();
      onBanner({
        kind: 'ok',
        text: `Built interactive bundle (${res.demoEntryRelPath}) for ${target.label}.`,
      });
    } else if (res.ok) {
      onBanner({ kind: 'ok', text: `Build succeeded for ${target.label}.` });
    } else {
      onBanner({ kind: 'err', text: `Build failed: ${res.output.slice(-240)}` });
    }
  } catch (e) {
    onBanner({ kind: 'err', text: errorMessage(e) });
  }
}

/** When and from which commit the target's demo was built, and whether its workspace moved on since. */
export function DemoFreshness({ target }: { target: WorkspaceDemoTarget }) {
  const badge = staleBadge(target);
  return (
    <span className="demo-freshness small">
      <span className={target.rebuilding ? 'demo-freshness-busy' : 'muted'}>{builtLine(target)}</span>
      {badge && <span className={target.demoBuild ? 'badge badge-warn' : 'badge badge-soft'}>{badge}</span>}
    </span>
  );
}
