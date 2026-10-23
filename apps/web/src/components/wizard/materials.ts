/** The wizard's reference files and links: kinds, caps, problems, thumbnails (no React). */
import {
  formatMaterialSize,
  MATERIAL_LIMITS,
  MATERIAL_MIME_TYPE_MAX,
  MATERIALS_ERROR_CODE,
  type MaterialKind,
  materialKind,
  type MaterialLimits,
  materialTypeLabel,
  type ProjectMaterialInfo,
  type ProjectMaterialInput,
  REFERENCE_URLS_MAX,
  type ReferenceUrl,
  referenceUrlProblem,
} from '@emberline/protocol';

const MB = 1024 * 1024;

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export interface WizardMaterial {
  id: string;
  /** The picked or dropped file; kept in memory only, never in the draft. */
  file: Blob;
  /** As picked, for display; core stores a sanitised name. */
  name: string;
  sizeBytes: number;
  mimeType: string;
  kind: MaterialKind;
}

export interface MaterialCandidate {
  file: Blob;
  name: string;
  isFolder?: boolean;
}

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
};

/** The browser's type, else one from the extension, so the web and core agree on the kind. */
export function materialMimeType(name: string, browserType: string): string {
  const type = browserType.trim();
  if (type && type.length <= MATERIAL_MIME_TYPE_MAX && !CONTROL_CHARS.test(type)) return type;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? 'application/octet-stream';
}

let lastId = 0;
/** List ids from a counter: crypto.randomUUID needs a secure context, and Emberline also runs on plain http. */
export const nextMaterialId = (): string => `material-${++lastId}`;

/** A drop's files as candidates; a dropped folder is marked, so `addMaterials` refuses it. */
export const droppedFiles = (data: Pick<DataTransfer, 'files' | 'items'>): MaterialCandidate[] => {
  const items = [...data.items].filter((item) => item.kind === 'file');
  return [...data.files].map((file, i) => ({
    file,
    name: file.name,
    isFolder: items[i]?.webkitGetAsEntry?.()?.isDirectory === true,
  }));
};

/** The files that fit, in order, and a plain sentence for each one that does not. */
export function addMaterials(
  current: readonly WizardMaterial[],
  candidates: readonly MaterialCandidate[],
  newId: () => string = nextMaterialId,
  limits: MaterialLimits = MATERIAL_LIMITS,
): { added: WizardMaterial[]; problems: string[] } {
  const added: WizardMaterial[] = [];
  const problems: string[] = [];
  let count = current.length;
  let total = current.reduce((sum, m) => sum + m.sizeBytes, 0);
  for (const c of candidates) {
    if (c.isFolder) problems.push(`${c.name} is a folder. Add the files inside it instead.`);
    else if (c.name.length > 255)
      problems.push(`${c.name.slice(0, 40)}… has a name longer than 255 characters.`);
    else if (CONTROL_CHARS.test(c.name))
      problems.push(
        `${JSON.stringify(c.name).slice(1, -1)} has line breaks or control characters in its name.`,
      );
    else if (!c.name.trim())
      problems.push('A file whose name is only spaces cannot be added. Rename it, then add it again.');
    else if (c.file.size === 0) problems.push(`${c.name} is empty.`);
    else if (count >= limits.maxFiles)
      problems.push(`${c.name} was not added: at most ${limits.maxFiles} files.`);
    else if (c.file.size > limits.maxFileBytes)
      problems.push(`${c.name} is larger than ${limits.maxFileBytes / MB} MB.`);
    else if (total + c.file.size > limits.maxTotalBytes)
      problems.push(`${c.name} would take the files over ${limits.maxTotalBytes / MB} MB.`);
    else {
      const mimeType = materialMimeType(c.name, c.file.type);
      added.push({
        id: newId(),
        file: c.file,
        name: c.name,
        sizeBytes: c.file.size,
        mimeType,
        kind: materialKind(mimeType),
      });
      count += 1;
      total += c.file.size;
    }
  }
  return { added, problems };
}

/** "7 of 20 files, 12.4 of 30 MB". */
export function capLine(
  materials: readonly WizardMaterial[],
  limits: MaterialLimits = MATERIAL_LIMITS,
): string {
  const total = materials.reduce((sum, m) => sum + m.sizeBytes, 0);
  return `${materials.length} of ${limits.maxFiles} files, ${(total / MB).toFixed(1)} of ${limits.maxTotalBytes / MB} MB`;
}

export function materialDetail(m: WizardMaterial): string {
  return `${materialTypeLabel(m.mimeType)}, ${formatMaterialSize(m.sizeBytes)}${m.kind === 'svg' ? ', not previewed' : ''}`;
}

/** One link per line, a note after the first space; problems name their line. */
export function parseReferenceUrls(text: string): { urls: ReferenceUrl[]; problems: string[] } {
  const urls: ReferenceUrl[] = [];
  const problems: string[] = [];
  let count = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    count += 1;
    const [url = '', ...rest] = line.split(/\s+/);
    const note = rest.join(' ') || undefined;
    const problem = referenceUrlProblem(url, note);
    if (problem) problems.push(`Line ${i + 1}: ${problem}`);
    else urls.push(note ? { url, note } : { url });
  });
  if (count > REFERENCE_URLS_MAX)
    return { urls, problems: [`Use at most ${REFERENCE_URLS_MAX} links; there are ${count}.`] };
  return { urls, problems };
}

export interface ObjectUrlApi {
  create(blob: Blob): string;
  revoke(url: string): void;
}

/** Object URLs for PNG/JPEG/WebP/GIF thumbnails; SVG never gets one (it can carry script). */
export class ThumbnailUrls {
  private readonly urls = new Map<string, string>();
  constructor(private readonly api: ObjectUrlApi) {}

  /** URLs for the listed images; URLs of files no longer listed are revoked. */
  sync(materials: readonly WizardMaterial[]): ReadonlyMap<string, string> {
    const keep = new Set<string>();
    for (const m of materials) {
      if (m.kind !== 'image') continue;
      keep.add(m.id);
      if (!this.urls.has(m.id)) this.urls.set(m.id, this.api.create(m.file));
    }
    for (const [id, url] of this.urls) {
      if (!keep.has(id)) {
        this.api.revoke(url);
        this.urls.delete(id);
      }
    }
    return new Map(this.urls);
  }

  revokeAll(): void {
    for (const url of this.urls.values()) this.api.revoke(url);
    this.urls.clear();
  }
}

export const materialInfos = (materials: readonly WizardMaterial[]): ProjectMaterialInfo[] =>
  materials.map(({ name, mimeType, sizeBytes }) => ({ name, mimeType, sizeBytes }));

/** Base64 in chunks (String.fromCharCode with 10 MB of arguments would overflow the stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class MaterialReadError extends Error {}

/** One file at a time, so only one file's bytes and its base64 are in memory together. */
export async function encodeMaterials(materials: readonly WizardMaterial[]): Promise<ProjectMaterialInput[]> {
  const out: ProjectMaterialInput[] = [];
  for (const m of materials) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await m.file.arrayBuffer());
    } catch {
      throw new MaterialReadError(`Couldn't read ${m.name}. Remove it and add it again.`);
    }
    out.push({ name: m.name, mimeType: m.mimeType, dataBase64: bytesToBase64(bytes) });
  }
  return out;
}

export const MATERIALS_TOO_LARGE_TEXT =
  'The files are larger than the server accepts. If Emberline runs behind a proxy, raise its upload limit (nginx: client_max_body_size).';

/** A create failure that belongs next to the Reference material area, or null. */
export function materialsErrorMessage(err: unknown, filesSent: boolean): string | null {
  if (err instanceof MaterialReadError) return err.message;
  if (!err || typeof err !== 'object') return null;
  const { status, code, message } = err as { status?: unknown; code?: unknown; message?: unknown };
  if (status === 413 && filesSent) return MATERIALS_TOO_LARGE_TEXT;
  if (status === 400 && code === MATERIALS_ERROR_CODE && typeof message === 'string') return message;
  return null;
}

/** Core names the field a refusal is about; without it the files are meant. */
export function materialsErrorField(err: unknown): 'files' | 'links' {
  const field =
    err && typeof err === 'object'
      ? ((err as { data?: { field?: unknown }; field?: unknown }).data?.field ??
        (err as { field?: unknown }).field)
      : undefined;
  return field === 'links' ? 'links' : 'files';
}

/** Names from a restored draft that are not in the list again yet. */
export const filesToAddAgain = (notKept: readonly string[], materials: readonly WizardMaterial[]): string[] =>
  notKept.filter((name) => !materials.some((m) => m.name === name));

export const notKeptText = (names: readonly string[]): string =>
  `Files are not kept in the draft. Add them again: ${names.join(', ')}.`;

/** What the summary says about where the files and links go. */
export function summaryMaterialsNote(fileCount: number, linkCount: number): string {
  const files = 'The files are committed to docs/reference/ with the first commit.';
  const links =
    'The links are listed in PROJECT.md, which is committed too. Emberline never opens the links.';
  return [fileCount > 0 ? files : '', linkCount > 0 ? links : ''].filter(Boolean).join(' ');
}

/** A dragleave that only moves onto a child of the drop zone does not leave it. */
export function leavesDropZone(zone: { contains: (n: never) => boolean }, related: unknown): boolean {
  return !related || !zone.contains(related as never);
}
