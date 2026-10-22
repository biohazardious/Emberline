import { describe, expect, it } from 'vitest';
import {
  addMaterials,
  bytesToBase64,
  capLine,
  encodeMaterials,
  filesToAddAgain,
  MaterialReadError,
  materialDetail,
  materialMimeType,
  materialsErrorMessage,
  notKeptText,
  parseReferenceUrls,
  ThumbnailUrls,
  type WizardMaterial,
} from './materials';

const MB = 1024 * 1024;
let n = 0;
const id = () => `t${++n}`;
const blob = (size: number, type = '') => new Blob([new Uint8Array(size)], { type });
const material = (
  name: string,
  size: number,
  mimeType: string,
  kind: WizardMaterial['kind'],
): WizardMaterial => ({
  id: id(),
  file: blob(1, mimeType),
  name,
  sizeBytes: size,
  mimeType,
  kind,
});

describe('file kinds', () => {
  it('takes the browser type, else the extension, else octet-stream', () => {
    expect(materialMimeType('a.png', 'image/png')).toBe('image/png');
    expect(materialMimeType('Shot.JPG', '')).toBe('image/jpeg');
    expect(materialMimeType('brief.pdf', '')).toBe('application/pdf');
    expect(materialMimeType('logo.svg', '')).toBe('image/svg+xml');
    expect(materialMimeType('design.fig', '')).toBe('application/octet-stream');
  });
});

describe('addMaterials', () => {
  it('adds files with their kind; refuses empty files and folders in plain words', () => {
    const { added, problems } = addMaterials(
      [],
      [
        { file: blob(10, 'image/png'), name: 'a.png' },
        { file: blob(10), name: 'logo.svg' },
        { file: blob(0), name: 'empty.txt' },
        { file: blob(0), name: 'assets', isFolder: true },
      ],
      id,
    );
    expect(added.map((m) => [m.name, m.kind, m.sizeBytes])).toEqual([
      ['a.png', 'image', 10],
      ['logo.svg', 'svg', 10],
    ]);
    expect(problems).toEqual(['empty.txt is empty.', 'assets is a folder. Add the files inside it instead.']);
  });
  it('refuses names the server would refuse', () => {
    const { added, problems } = addMaterials(
      [],
      [
        { file: blob(1), name: 'a'.repeat(256) },
        { file: blob(1), name: 'x\ny.png' },
      ],
      id,
    );
    expect(added).toEqual([]);
    expect(problems).toEqual([
      `${'a'.repeat(40)}… has a name longer than 255 characters.`,
      'x\\ny.png has line breaks or control characters in its name.',
    ]);
  });
  it('holds the count, per-file and total caps', () => {
    const current = Array.from({ length: 19 }, (_, i) =>
      material(`f${i}`, MB, 'application/octet-stream', 'other'),
    );
    const { added, problems } = addMaterials(
      current,
      [
        { file: blob(1), name: 'twenty' },
        { file: blob(1), name: 'twenty-one' },
      ],
      id,
    );
    expect(added.map((m) => m.name)).toEqual(['twenty']);
    expect(problems).toEqual(['twenty-one was not added: at most 20 files.']);
    expect(addMaterials([], [{ file: blob(10 * MB + 1), name: 'big.bin' }], id).problems).toEqual([
      'big.bin is larger than 10 MB.',
    ]);
    const full = [
      material('a', 10 * MB, 'x', 'other'),
      material('b', 10 * MB, 'x', 'other'),
      material('c', 9 * MB, 'x', 'other'),
    ];
    expect(addMaterials(full, [{ file: blob(MB + 1), name: 'd.bin' }], id).problems).toEqual([
      'd.bin would take the files over 30 MB.',
    ]);
    expect(addMaterials(full, [{ file: blob(MB), name: 'e.bin' }], id).added).toHaveLength(1);
  });
});

describe('cap line and details', () => {
  it('reads "7 of 20 files, 12.4 of 30 MB"', () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      material(`f${i}`, i === 0 ? 13_002_342 - 6 : 1, 'x', 'other'),
    );
    expect(capLine(seven)).toBe('7 of 20 files, 12.4 of 30 MB');
    expect(capLine([])).toBe('0 of 20 files, 0.0 of 30 MB');
  });
  it('says type and size; SVG is never previewed', () => {
    expect(materialDetail(material('a.png', 108, 'image/png', 'image'))).toBe('PNG image, 108 bytes');
    expect(materialDetail(material('logo.svg', 41, 'image/svg+xml', 'svg'))).toBe(
      'SVG image, 41 bytes, not previewed',
    );
  });
});

describe('parseReferenceUrls', () => {
  it('one link per line, an optional note after it, blank lines skipped', () => {
    expect(
      parseReferenceUrls('https://example.com/app like this one\n\n  https://example.com/palette  \n'),
    ).toEqual({
      urls: [
        { url: 'https://example.com/app', note: 'like this one' },
        { url: 'https://example.com/palette' },
      ],
      problems: [],
    });
  });
  it('names the line of each problem; more than 20 links is one problem', () => {
    expect(parseReferenceUrls('https://ok.example\nftp://x.example\nhttps://u:p@x.example').problems).toEqual(
      [
        'Line 2: Use a link that starts with http:// or https://.',
        'Line 3: Remove the user name and password from the link.',
      ],
    );
    const many = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`).join('\n');
    expect(parseReferenceUrls(many).problems).toEqual(['Use at most 20 links; there are 21.']);
  });
});

describe('ThumbnailUrls', () => {
  const fake = () => {
    const created: string[] = [];
    const revoked: string[] = [];
    let k = 0;
    return {
      created,
      revoked,
      api: {
        create: () => {
          const u = `blob:${++k}`;
          created.push(u);
          return u;
        },
        revoke: (u: string) => revoked.push(u),
      },
    };
  };
  it('makes URLs for PNG/JPEG/WebP/GIF only, revokes on removal and on revokeAll', () => {
    const f = fake();
    const reg = new ThumbnailUrls(f.api);
    const png = material('a.png', 1, 'image/png', 'image');
    const svg = material('logo.svg', 1, 'image/svg+xml', 'svg');
    const pdf = material('b.pdf', 1, 'application/pdf', 'pdf');
    expect([...reg.sync([png, svg, pdf]).keys()]).toEqual([png.id]);
    reg.sync([png, svg, pdf]); // no second URL for the same file
    expect(f.created).toEqual(['blob:1']);
    const gif = material('c.gif', 1, 'image/gif', 'image');
    reg.sync([svg, gif]);
    expect(f.revoked).toEqual(['blob:1']);
    reg.revokeAll();
    expect(f.revoked).toEqual(['blob:1', 'blob:2']);
    expect(reg.sync([]).size).toBe(0);
    reg.sync([png, gif]);
    reg.revokeAll(); // what unmount does
    expect(f.revoked).toEqual(['blob:1', 'blob:2', 'blob:3', 'blob:4']);
  });
});

describe('sending the files', () => {
  it('base64 matches Node for sizes around the chunk boundary', () => {
    for (const size of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 * 3 + 7]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 256);
      expect(bytesToBase64(bytes), String(size)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
  it('encodes each file as { name, mimeType, dataBase64 }', async () => {
    const m = { ...material('a.png', 3, 'image/png', 'image'), file: new Blob([new Uint8Array([1, 2, 3])]) };
    expect(await encodeMaterials([m])).toEqual([{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AQID' }]);
  });
  it('a file that cannot be read any more names itself', async () => {
    const broken = {
      ...material('gone.pdf', 3, 'application/pdf', 'pdf'),
      file: { arrayBuffer: () => Promise.reject(new Error('NotReadableError')) } as unknown as Blob,
    };
    await expect(encodeMaterials([broken])).rejects.toEqual(
      new MaterialReadError("Couldn't read gone.pdf. Remove it and add it again."),
    );
  });
});

describe('errors next to the area', () => {
  it("maps core's invalid_materials, a 413 and a read failure; anything else stays with the dialog", () => {
    expect(materialsErrorMessage({ status: 400, code: 'invalid_materials', message: 'photo.png is not a PNG file.' })).toBe(
      'photo.png is not a PNG file.',
    );
    expect(materialsErrorMessage({ status: 413, code: 'bad_request', message: 'Request body is too large' })).toBe(
      'The files are too large for the server to accept. Remove some and try again.',
    );
    expect(materialsErrorMessage(new MaterialReadError("Couldn't read a.png. Remove it and add it again."))).toBe(
      "Couldn't read a.png. Remove it and add it again.",
    );
    expect(materialsErrorMessage({ status: 400, code: 'bad_request', message: 'x' })).toBeNull();
    expect(materialsErrorMessage({ status: 409, code: 'name_taken', message: 'x' })).toBeNull();
  });
});

describe('after a reload', () => {
  it('asks to add again only the files not re-added yet', () => {
    const again = filesToAddAgain(['a.png', 'brief.pdf'], [material('a.png', 1, 'image/png', 'image')]);
    expect(again).toEqual(['brief.pdf']);
    expect(notKeptText(again)).toBe('Files are not kept in the draft. Add them again: brief.pdf.');
  });
});
