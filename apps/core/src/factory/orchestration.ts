/** Factory orchestration: request attachments, the orchestrator prompt and agent-written ticket drafts. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentCreateTicketsPayload,
  type AgentTicketDraft,
  type FactoryAttachmentInput,
} from '@emberline/protocol';
import { execGitFile } from '../git-exec.js';

/** Safe characters only (`[A-Za-z0-9._-]`), runs of others become one `-`, no leading/trailing `-`. */
export function sanitizeAttachmentName(name: string, fallback: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

export async function persistFactoryAttachments(
  workspacePath: string,
  attachments: readonly FactoryAttachmentInput[],
): Promise<string> {
  if (!attachments || attachments.length === 0) return '';
  const attachDir = path.join(workspacePath, '.emberline', 'attachments');
  await mkdir(attachDir, { recursive: true });

  const ts = Date.now();
  const sections: string[] = [];

  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i]!;
    const safeName = sanitizeAttachmentName(att.name, `file-${i + 1}`);
    const storedName = `${ts}-${i + 1}-${safeName}`;
    const absPath = path.join(attachDir, storedName);

    const rawBase64 = att.dataBase64.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(rawBase64, 'base64');
    await writeFile(absPath, buf);

    const sizeKb = Math.max(1, Math.round(buf.length / 1024));
    const ext = path.extname(safeName).toLowerCase();
    const isImage =
      att.mimeType.startsWith('image/') ||
      ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico'].includes(ext);
    const isTextLike =
      att.mimeType.startsWith('text/') ||
      att.mimeType === 'application/json' ||
      [
        '.md',
        '.txt',
        '.json',
        '.csv',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.css',
        '.html',
        '.yaml',
        '.yml',
        '.xml',
        '.svg',
        '.py',
        '.sh',
        '.go',
        '.rs',
        '.c',
        '.cpp',
        '.h',
        '.ino',
        '.ini',
      ].includes(ext);

    if (isImage) {
      sections.push(
        `- 🖼️ **Image / Visual Asset:** \`${att.name}\` (${att.mimeType}, ${sizeKb} KB)\n  - **Absolute Path:** \`${absPath}\`\n  - **Action:** Use your \`Read\` tool on \`${absPath}\` to visually inspect this image/screenshot/diagram/mockup, and copy it into the project assets directory if the user wants it embedded. **Include this exact path \`${absPath}\` in delegated \`ui_ux\` / \`coder\` ticket bodies!**`,
      );
    } else if (isTextLike && buf.length <= 16_384 && !buf.subarray(0, 1024).includes(0)) {
      const preview = buf.toString('utf8').trim();
      sections.push(
        `- 📄 **Attached File:** \`${att.name}\` (${att.mimeType}, ${sizeKb} KB)\n  - **Absolute Path:** \`${absPath}\`\n  - **Content Preview:**\n\`\`\`\n${preview.slice(0, 6000)}\n\`\`\``,
      );
    } else {
      sections.push(
        `- 📎 **Attached File:** \`${att.name}\` (${att.mimeType}, ${sizeKb} KB)\n  - **Absolute Path:** \`${absPath}\`\n  - **Action:** Read or inspect \`${absPath}\` and include this path in delegated specialist ticket bodies.`,
      );
    }
  }

  return sections.join('\n\n');
}

/** Title of the `[Factory]` ticket for a request: its first line, cut at 120 chars. */
export function factoryTicketTitle(prompt: string): string {
  return `[Factory] ${prompt.split('\n')[0]?.trim().slice(0, 120) || 'Feature Request'}`;
}

export function buildFactoryOrchestratorPrompt(
  userRequest: string,
  autoDispatch = true,
  attachmentContext = '',
  maxParallelTickets = 2,
): string {
  const attachmentSection = attachmentContext.trim()
    ? `\n### Attached Reference Files & Visual Assets (Uploaded by User):\n${attachmentContext.trim()}\n`
    : '';

  return `## AI Coding Factory — Feature Request & Multi-Layer Specialist Delegation

User Request:
"""
${userRequest.trim()}
"""
${attachmentSection}
### Your Mission (as Lead Product Owner & Factory Orchestrator):
1. **Inspect Architecture & Attached Files:** Read \`PROJECT.md\`, inspect any **Attached Reference Files / Images** listed above using your \`Read\` tool, and inspect the repository structure so you understand the project's exact stack and layers (e.g., Full-Stack Web/Portal, Multi-Package Monorepo, Backend API/Microservice, Multi-Agent Platform, Desktop/Mobile App, CLI/System Automation, or Embedded/IoT Firmware).
2. **Refine Specification:** Translate the user's request (and any attached specs/diagrams/screenshots) into a clear engineering specification and update \`PROJECT.md\` if needed.
3. **Delegate to Specialist Personas (DO NOT implement the entire feature yourself):**
   Break the work down into concrete, non-overlapping sub-tasks for the relevant specialist personas based on the project's architecture:
   - \`architect\` (when cross-layer contracts, monorepo packages, or system protocols change): Module boundaries, shared schemas/types, or hardware/IPC contracts.
   - \`dba\` (when persistence/database schemas change): Database tables, migrations, indexes, or storage models.
   - \`coder\`: Core business logic, backend services/APIs, CLI/system automation scripts, desktop/native state, build/packaging, or embedded firmware implementation.
   - \`ui_ux\` (when user-facing surfaces exist): Web/Portal pages, forms, dashboards, desktop/mobile GUI views, brand assets, or interactive CLI/TUI output ergonomics.
   - \`qa\`: Unit/integration/E2E tests, safety/regression checks, and running the project's build/compile verification pipeline.
   **Order the work:** give every ticket a short unique \`ref\` and list the refs of the tickets it needs in \`dependsOn\`. Refs are lowercase letters, digits and hyphens, start with a letter or digit, up to 40 characters (e.g. \`brand-assets\`); a ticket has up to 10 \`dependsOn\` entries; an existing ticket is referenced by its key, e.g. \`MPG-12\`.
   - Producers come before consumers: assets, schemas, contracts, and migrations first, then the code that uses them.
   - Builds, packaging, and integration depend on everything they package or wire together.
   - QA depends on the tickets whose work it verifies.
   - Work that is truly independent gets no \`dependsOn\`, so it can run in parallel.
   - Keep chains short; do not chain tickets that do not need each other's output.
   - A ticket's priority (0–3) only breaks ties between tickets that are ready at the same time; dependencies, not priority, decide the order.
   *(If the user attached images, screenshots, schemas, logs, or reference files above, ALWAYS copy their exact Absolute Paths into the \`body\` of the relevant delegated tickets so those specialists can inspect or use them!)*
4. **Write Delegated Tickets to \`.emberline/new-tickets.json\`:**
   Create the directory \`.emberline\` if needed and write \`.emberline/new-tickets.json\` with the exact JSON structure below (include only the tickets relevant to this request; this example builds an Android APK):
   \`\`\`json
   {
     "autoDispatch": ${autoDispatch ? 'true' : 'false'},
     "tickets": [
       { "ref": "brand-assets", "title": "UI/UX: app icon, splash and store graphics", "persona": "ui_ux", "priority": 2, "body": "## Objective\\n...\\n\\n## Target Files\\n...\\n\\n## Acceptance Criteria\\n- ..." },
       { "ref": "android-shell", "title": "Core / Build: Capacitor Android shell", "persona": "coder", "priority": 2, "body": "## Objective\\n..." },
       { "ref": "apk-build", "title": "Core / Build: wire the branding into android/ and build the signed APK", "persona": "coder", "priority": 2, "dependsOn": ["brand-assets", "android-shell"], "body": "## Objective\\n..." },
       { "ref": "qa", "title": "QA & Build Verification: install and smoke-test the APK", "persona": "qa", "priority": 1, "dependsOn": ["apk-build"], "body": "## Objective\\n..." }
     ]
   }
   \`\`\`
   *(Keep \`.emberline/new-tickets.json\` on disk when you finish; Emberline Core will automatically ingest it, create the tickets on the Kanban Board, and sync your \`PROJECT.md\` update to \`main\`. Emberline starts each ticket as soon as every ticket it depends on is merged into main, up to ${maxParallelTickets} tickets of this project at once; tickets without dependencies start right away.)*
5. **Autonomous Execution Rule (CRITICAL):** Do NOT ask the user clarifying questions and do NOT wait for confirmation. Always select the cleanest architecture-appropriate design that fits \`PROJECT.md\` and write \`.emberline/new-tickets.json\` in this turn.`;
}

/** Why a tickets file was consumed without creating tickets. */
export type TicketsFileSkip = 'inherited' | 'duplicate';

export interface TicketsFileHooks {
  /** A file that is not valid JSON or not a valid batch: why. */
  onRejected?: (message: string) => void;
  /**
   * Whether the file is the one the run's branch started with (`relPath` is relative to the
   * workspace): such a file came from main, not from this run, and creates no tickets.
   */
  isInherited?: (relPath: string, raw: Buffer) => Promise<boolean>;
  /**
   * Called synchronously with a valid file's sha256 just before it is imported: false when that
   * content was imported before (the file is skipped), true after recording it.
   */
  claim?: (sha256: string) => boolean;
  onSkipped?: (reason: TicketsFileSkip, file: string, sha256: string) => void;
}

/**
 * Reads and consumes the drafts file an agent wrote. A file that is not valid JSON or not a valid
 * batch is still removed; `onRejected` hears why, so the run can say so instead of failing silently.
 * A file the hooks skip (inherited from main, or already imported) is removed too.
 */
export async function ingestAgentTicketsFile(
  workspacePath: string,
  hooks: TicketsFileHooks = {},
): Promise<{ autoDispatch: boolean; tickets: AgentTicketDraft[]; sha256: string } | null> {
  const { onRejected, isInherited, claim, onSkipped } = hooks;
  for (const name of ['new-tickets.json', 'tickets.json']) {
    const relPath = `.emberline/${name}`;
    const filePath = path.join(workspacePath, '.emberline', name);
    if (!existsSync(filePath)) continue;
    try {
      const raw = await readFile(filePath);
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const inherited = isInherited ? await isInherited(relPath, raw).catch(() => false) : false;
      await rm(filePath, { force: true });
      if (inherited) {
        onSkipped?.('inherited', name, sha256);
        continue;
      }
      const json = JSON.parse(raw.toString('utf-8')) as unknown;
      const parsed = AgentCreateTicketsPayload.parse(
        Array.isArray(json) ? { autoDispatch: true, tickets: json } : json,
      );
      if (claim && !claim(sha256)) {
        onSkipped?.('duplicate', name, sha256);
        continue;
      }
      return { ...parsed, sha256 };
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => undefined);
      onRejected?.(`${name}: ${(error as Error).message}`.slice(0, 500));
    }
  }
  return null;
}

/**
 * Whether `relPath` is committed at `ref` with exactly the bytes `raw` (hardened `ls-tree` and
 * `cat-file`; the size from the tree is checked before the blob is read). False when it is not
 * committed there, or on any git error.
 */
export async function committedWithContent(
  workspacePath: string,
  ref: string,
  relPath: string,
  raw: Buffer,
): Promise<boolean> {
  const inDir = { cwd: workspacePath };
  const tree = await execGitFile(['ls-tree', '-l', '-z', ref, '--', relPath], inDir).catch(() => ({
    stdout: '',
  }));
  const record = tree.stdout.split('\0').find(Boolean);
  if (!record) return false;
  const tab = record.indexOf('\t');
  const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/);
  if (
    record.slice(tab + 1) !== relPath ||
    mode === '120000' ||
    type !== 'blob' ||
    !oid ||
    !/^[0-9a-f]{40,64}$/.test(oid)
  ) {
    return false;
  }
  if (Number(size) !== raw.length) return false;
  const blob = await execGitFile(['cat-file', 'blob', oid], {
    ...inDir,
    encoding: 'buffer',
    maxBuffer: Math.max(raw.length + 1, 64 * 1024),
  });
  return blob.stdout.equals(raw);
}

/**
 * The commit a run's branch started from (its merge-base with the main workspace's branch), or
 * HEAD when there is no such branch or no common history.
 */
export async function runBranchBase(worktreePath: string, mainBranch: string | null): Promise<string> {
  if (!mainBranch) return 'HEAD';
  const res = await execGitFile(['merge-base', 'HEAD', `refs/heads/${mainBranch}`], {
    cwd: worktreePath,
  }).catch(() => ({ stdout: '' }));
  return res.stdout.trim() || 'HEAD';
}
