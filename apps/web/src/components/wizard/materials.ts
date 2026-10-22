/** The wizard's reference files and links: kinds, caps, problems, thumbnails (no React). */
import {
  formatMaterialSize,
  MATERIAL_LIMITS,
  type MaterialKind,
  materialKind,
  type MaterialLimits,
  materialTypeLabel,
  REFERENCE_URLS_MAX,
  type ReferenceUrl,
  referenceUrlProblem,
} from '@emberline/protocol';

const MB = 1024 * 1024;

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
  if (browserType.trim()) return browserType.trim();
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? 'application/octet-stream';
}

let lastId = 0;
/** List ids from a counter: crypto.randomUUID needs a secure context, and Emberline also runs on plain http. */
export const nextMaterialId = (): string => `material-${++lastId}`;

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
