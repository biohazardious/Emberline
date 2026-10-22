/** Wizard reference files: decode and check, stored names; Task 2 adds the write and the PROJECT.md / ticket text. */
import path from 'node:path';
import {
  MATERIAL_LIMITS,
  MATERIALS_DIR,
  MATERIALS_ERROR_CODE,
  materialCheckedType,
  type MaterialKind,
  materialKind,
  type MaterialLimits,
  type ProjectMaterial,
  type ProjectMaterialInfo,
} from '@emberline/protocol';
import { HttpError } from '../errors.js';
import { sanitizeAttachmentName } from './orchestration.js';

export type DecodedMaterial = ProjectMaterialInfo & { bytes: Buffer };
export type PlannedMaterial = ProjectMaterialInfo & { kind: MaterialKind; path: string };

const MB = 1024 * 1024;
const STORED_NAME_MAX = 100;
const materialsError = (message: string) => new HttpError(400, MATERIALS_ERROR_CODE, message);
const ascii = (bytes: Uint8Array, start: number, end: number) =>
  Buffer.from(bytes.subarray(start, end)).toString('latin1');

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) =>
    Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6)),
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  // Readers accept the header anywhere in the first 1024 bytes.
  'application/pdf': (b) => Buffer.from(b.subarray(0, 1024)).includes('%PDF-'),
};

/** Images and PDFs must start like their declared type; SVG and other files are not checked. */
export function matchesDeclaredType(mimeType: string, bytes: Uint8Array): boolean {
  const check = SIGNATURES[(mimeType.split(';')[0] ?? '').trim().toLowerCase()];
  return check ? check(bytes) : true;
}

/** Decodes the create body's files and checks them again on the decoded bytes (the browser checked first). */
export function decodeMaterials(
  inputs: readonly ProjectMaterial[],
  limits: MaterialLimits = MATERIAL_LIMITS,
): DecodedMaterial[] {
  if (inputs.length > limits.maxFiles) throw materialsError(`Attach at most ${limits.maxFiles} files.`);
  const out: DecodedMaterial[] = [];
  let total = 0;
  for (const input of inputs) {
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.length === 0) throw materialsError(`${input.name} is empty.`);
    if (bytes.length > limits.maxFileBytes)
      throw materialsError(`${input.name} is larger than ${limits.maxFileBytes / MB} MB.`);
    total += bytes.length;
    if (total > limits.maxTotalBytes)
      throw materialsError(`The files add up to more than ${limits.maxTotalBytes / MB} MB.`);
    const checked = materialCheckedType(input.mimeType);
    if (checked && !matchesDeclaredType(input.mimeType, bytes))
      throw materialsError(`${input.name} is not a ${checked} file.`);
    out.push({ name: input.name, mimeType: input.mimeType, sizeBytes: bytes.length, bytes });
  }
  return out;
}

/** The file name in docs/reference/: base name only, `[A-Za-z0-9._-]`, no leading dot, lower-case extension, ≤ 100 chars. */
export function storedMaterialName(name: string, index: number): string {
  const fallback = `file-${index + 1}`;
  const base = path.posix.basename(name.replace(/\\/g, '/'));
  const rawExt = path.posix.extname(base);
  const ext = sanitizeAttachmentName(rawExt.slice(1), '').toLowerCase().slice(0, 10);
  const stem = sanitizeAttachmentName(base.slice(0, base.length - rawExt.length), '').replace(/^[.-]+/, '');
  const room = STORED_NAME_MAX - (ext ? ext.length + 1 : 0);
  const safeStem = (stem || fallback).slice(0, room).replace(/[-.]+$/, '') || fallback;
  return ext ? `${safeStem}.${ext}` : safeStem;
}

/**
 * Paths under docs/reference/ in the body's order. A clash (ignoring case, so the repository also
 * checks out on case-insensitive file systems) gets -2, -3… before the extension. `reserved` are
 * other paths the create writes.
 */
export function planMaterials(
  infos: readonly ProjectMaterialInfo[],
  reserved: Iterable<string> = [],
): PlannedMaterial[] {
  const used = new Set([...reserved].map((p) => p.toLowerCase()));
  return infos.map((info, i) => {
    const stored = storedMaterialName(info.name, i);
    const ext = path.posix.extname(stored);
    const stem = stored.slice(0, stored.length - ext.length);
    let candidate = `${MATERIALS_DIR}/${stored}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${MATERIALS_DIR}/${stem}-${n}${ext}`;
    used.add(candidate.toLowerCase());
    return {
      name: info.name,
      mimeType: info.mimeType,
      sizeBytes: info.sizeBytes,
      kind: materialKind(info.mimeType),
      path: candidate,
    };
  });
}
