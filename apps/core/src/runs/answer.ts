/** The prompt an answer becomes, and where its files are stored. Pure. */
import { ANSWER_ATTACHMENTS_DIR, formatMaterialSize, type RunQuestion } from '@emberline/protocol';
import { storedMaterialName } from '../factory/materials.js';

export interface StoredAttachment {
  path: string;
  mimeType: string;
  sizeBytes: number;
}

/** `20261023-101500`. */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export function answerAttachmentPaths(names: string[], now: Date): string[] {
  return names.map(
    (name, i) => `${ANSWER_ATTACHMENTS_DIR}/${stamp(now)}-${i + 1}-${storedMaterialName(name, i)}`,
  );
}

function filesBlock(files: StoredAttachment[]): string {
  if (files.length === 0) return '';
  return [
    'Attached files (in your worktree):',
    ...files.map((f) => `- ${f.path} (${f.mimeType}, ${formatMaterialSize(f.sizeBytes)})`),
  ].join('\n');
}

export function answerPrompt(
  q: Pick<RunQuestion, 'kind' | 'text'>,
  answer: string,
  files: StoredAttachment[],
  completionReminder: string,
): string {
  const body = [answer.trim(), filesBlock(files)].filter(Boolean).join('\n\n');
  if (q.kind !== 'blocked') return body;
  const quoted = (q.text || '(no details)')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `You reported that you are blocked:\n\n${quoted}\n\nMy answer:\n\n${body}\n\nContinue the work with this answer, run the project's checks, commit, and finish.${completionReminder}`;
}
