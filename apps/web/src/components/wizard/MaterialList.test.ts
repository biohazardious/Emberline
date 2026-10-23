// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderDom } from '../../domRender';
import { MaterialList } from './MaterialList';
import type { WizardMaterial } from './materials';

const image = (id: string): WizardMaterial => ({
  id,
  file: new Blob(['png'], { type: 'image/png' }),
  name: `${id}.png`,
  sizeBytes: 3,
  mimeType: 'image/png',
  kind: 'image',
});

let created: string[];
let revoked: string[];
beforeEach(() => {
  created = [];
  revoked = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:thumb-${created.length + 1}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('MaterialList thumbnails (D-12)', () => {
  it('shows each image by its object URL and revokes every one on unmount', async () => {
    const view = await renderDom(createElement(MaterialList, { materials: [image('a'), image('b')] }));
    const srcs = [...view.container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(srcs).toEqual(['blob:thumb-1', 'blob:thumb-2']);
    expect(revoked).toEqual([]);
    await view.unmount();
    expect(revoked.sort()).toEqual(['blob:thumb-1', 'blob:thumb-2']);
  });

  it('revokes the URL of a file that leaves the list, and only that one', async () => {
    const a = image('a');
    const view = await renderDom(createElement(MaterialList, { materials: [a, image('b')] }));
    await view.rerender(createElement(MaterialList, { materials: [a] }));
    expect(revoked).toEqual(['blob:thumb-2']);
    await view.unmount();
    expect(revoked).toEqual(['blob:thumb-2', 'blob:thumb-1']);
  });
});
