import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import { decodeMaterials, matchesDeclaredType, planMaterials, storedMaterialName } from './materials.js';
import { sanitizeAttachmentName } from './orchestration.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
const PDF = Buffer.from(`%PDF-1.7\n${'x'.repeat(2000)}`);
const b64 = (b: Buffer) => b.toString('base64');
const fail = (fn: () => unknown): HttpError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected a refusal');
};

describe('magic bytes', () => {
  it('accepts each checked type with its own signature and refuses the others', () => {
    const cases: [string, Buffer][] = [
      ['image/png', PNG],
      ['image/jpeg', JPEG],
      ['image/webp', WEBP],
      ['image/gif', GIF],
      ['application/pdf', PDF],
    ];
    for (const [type, bytes] of cases) {
      expect(matchesDeclaredType(type, bytes), type).toBe(true);
      for (const [other, otherBytes] of cases)
        if (other !== type) expect(matchesDeclaredType(type, otherBytes), `${type} vs ${other}`).toBe(false);
    }
    expect(matchesDeclaredType('IMAGE/PNG', PNG)).toBe(true);
  });
  it('a PDF header may follow up to 1024 bytes of leading junk, not more', () => {
    expect(matchesDeclaredType('application/pdf', Buffer.concat([Buffer.alloc(1000, 32), PDF]))).toBe(true);
    expect(matchesDeclaredType('application/pdf', Buffer.concat([Buffer.alloc(1024, 32), PDF]))).toBe(false);
  });
  it('SVG and other files are not checked by content', () => {
    expect(matchesDeclaredType('image/svg+xml', Buffer.from('anything'))).toBe(true);
    expect(matchesDeclaredType('application/octet-stream', Buffer.from('anything'))).toBe(true);
  });
});

describe('decodeMaterials', () => {
  const small = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
  const file = (name: string, bytes: Buffer, mimeType = 'application/octet-stream') => ({
    name,
    mimeType,
    dataBase64: b64(bytes),
  });

  it('decodes and keeps order, name and declared type; sizes are the decoded bytes', () => {
    const out = decodeMaterials([file('a.png', PNG, 'image/png'), file('b.pdf', PDF, 'application/pdf')]);
    expect(out.map((m) => [m.name, m.mimeType, m.sizeBytes])).toEqual([
      ['a.png', 'image/png', 108],
      ['b.pdf', 'application/pdf', 2009],
    ]);
    expect(out[0]!.bytes.equals(PNG)).toBe(true);
  });
  it('refuses with invalid_materials and a plain sentence', () => {
    expect(
      fail(() =>
        decodeMaterials(
          [file('a', Buffer.alloc(1)), file('b', Buffer.alloc(1)), file('c', Buffer.alloc(1))],
          small,
        ),
      ).message,
    ).toBe('Attach at most 2 files.');
    const mismatch = fail(() => decodeMaterials([file('photo.png', JPEG, 'image/png')]));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.code).toBe('invalid_materials');
    expect(mismatch.message).toBe('photo.png is not a PNG file.');
    expect(fail(() => decodeMaterials([file('scan.pdf', PNG, 'application/pdf')])).message).toBe(
      'scan.pdf is not a PDF file.',
    );
  });
  it('checks the decoded size, not the encoded one', () => {
    // 10 MB + 2 bytes encodes to exactly the encoded cap without padding, so zod lets it through.
    const big = Buffer.alloc(10 * 1024 * 1024 + 2);
    expect(fail(() => decodeMaterials([file('big.bin', big)])).message).toBe('big.bin is larger than 10 MB.');
    const tenMb = Buffer.alloc(10 * 1024 * 1024);
    expect(
      fail(() =>
        decodeMaterials([file('a', tenMb), file('b', tenMb), file('c', tenMb), file('d', Buffer.alloc(1))]),
      ).message,
    ).toBe('The files add up to more than 30 MB.');
    expect(
      decodeMaterials([file('a', tenMb), file('b', tenMb), file('c', tenMb)]).map((m) => m.sizeBytes),
    ).toEqual([tenMb.length, tenMb.length, tenMb.length]);
  });
  it('refuses an empty file', () => {
    expect(
      fail(() => decodeMaterials([{ name: 'empty.txt', mimeType: 'text/plain', dataBase64: '====' }]))
        .message,
    ).toBe('empty.txt is empty.');
  });
});

describe('stored names', () => {
  it('keeps the factory attachment sanitising', () => {
    // Today's regex, pinned so persistFactoryAttachments stays byte-identical: "(1)" becomes "-1-".
    expect(sanitizeAttachmentName('My Shot (1).png', 'file-1')).toBe('My-Shot-1-.png');
    expect(sanitizeAttachmentName('***', 'file-3')).toBe('file-3');
  });
  it('a plain file name: base name only, safe characters, no leading dot, lower-case extension, at most 100 characters', () => {
    const cases: [string, string][] = [
      ['Home Screen.png', 'Home-Screen.png'],
      ['Shot.PNG', 'Shot.png'],
      ['../../etc/passwd', 'passwd'],
      ['a\\b\\c.png', 'c.png'],
      ['..', 'file-1'],
      ['.env', 'env'],
      ['.git', 'git'],
      ['日本語.png', 'file-1.png'],
      ['-dash-.png', 'dash.png'],
      ['archive.tar.gz', 'archive.tar.gz'],
      ['name.', 'name'],
    ];
    for (const [name, stored] of cases) expect(storedMaterialName(name, 0), name).toBe(stored);
    const long = storedMaterialName(`${'x'.repeat(300)}.pdf`, 4);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(storedMaterialName('…', 4)).toBe('file-5');
  });
  it('clashes get -2, -3 before the extension, compared without case, also against reserved paths', () => {
    const infos = ['Home Screen.png', 'home-screen.PNG', 'Home Screen.png', 'brief.pdf'].map((name) => ({
      name,
      mimeType: 'image/png',
      sizeBytes: 1,
    }));
    expect(planMaterials(infos, ['docs/reference/brief.pdf']).map((m) => m.path)).toEqual([
      'docs/reference/Home-Screen.png',
      'docs/reference/home-screen-2.png',
      'docs/reference/Home-Screen-3.png',
      'docs/reference/brief-2.pdf',
    ]);
    expect(planMaterials([{ name: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 41 }])[0]).toMatchObject({
      kind: 'svg',
      path: 'docs/reference/logo.svg',
    });
  });
});
