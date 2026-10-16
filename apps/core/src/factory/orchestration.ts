/** Factory orchestration: request attachments, the orchestrator prompt and agent-written ticket drafts. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentCreateTicketsPayload,
  type AgentTicketDraft,
  type FactoryAttachmentInput,
} from '@emberline/protocol';

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
    const safeName = att.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `file-${i + 1}`;
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
      ['.md', '.txt', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.yaml', '.yml', '.xml', '.svg', '.py', '.sh', '.go', '.rs', '.c', '.cpp', '.h', '.ino', '.ini'].includes(
        ext,
      );

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

export function buildFactoryOrchestratorPrompt(
  userRequest: string,
  autoDispatch = true,
  attachmentContext = '',
  maxParallelTickets = 3,
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
   **Order the work:** give every ticket a short unique \`ref\` (lowercase letters, digits and hyphens, e.g. \`brand-assets\`) and list the refs of the tickets it needs in \`dependsOn\` (you may also name the key of an existing ticket).
   - Producers come before consumers: assets, schemas, contracts, and migrations first, then the code that uses them.
   - Builds, packaging, and integration depend on everything they package or wire together.
   - QA depends on the tickets whose work it verifies.
   - Work that is truly independent gets no \`dependsOn\`, so it can run in parallel.
   - Keep chains short; do not chain tickets that do not need each other's output.
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

export async function ingestAgentTicketsFile(
  workspacePath: string,
): Promise<{ autoDispatch: boolean; tickets: AgentTicketDraft[] } | null> {
  const candidates = [
    path.join(workspacePath, '.emberline', 'new-tickets.json'),
    path.join(workspacePath, '.emberline', 'tickets.json'),
  ];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = await readFile(filePath, 'utf-8');
      await rm(filePath, { force: true });
      const json = JSON.parse(raw) as unknown;
      const parsed = AgentCreateTicketsPayload.parse(
        Array.isArray(json) ? { autoDispatch: true, tickets: json } : json,
      );
      return parsed;
    } catch {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}
