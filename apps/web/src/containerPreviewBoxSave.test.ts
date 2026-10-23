// @vitest-environment happy-dom
import type { ContainerPreviewOptionsResponse, Project } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import type * as ApiModule from './api';
import { ContainerPreviewBox } from './components/ContainerPreviewBox';
import { USE_CONTAINER_PREVIEW_LABEL } from './containerPreviewSetup';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const project = { id: 'p1', name: 'Shop' } as Project;
const url = '/api/projects/p1/container-preview';
const options: ContainerPreviewOptionsResponse = {
  available: true,
  reason: null,
  file: 'compose.yaml',
  services: [{ name: 'web', ports: [3000] }],
  commandPreview: true,
};

let optionReads: number;
let saves: unknown[];

beforeEach(() => {
  optionReads = 0;
  saves = [];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      // The first read works; every refetch after the save fails.
      [`GET ${url}`]: () => {
        if (optionReads++ > 0) throw new ApiRequestError(502, 'http_error', 'Bad Gateway');
        return options;
      },
      [`POST ${url}/diff`]: () => ({ content: 'preview: {}\n', diff: '+preview: {}', baseSha256: null }),
      [`POST ${url}`]: (body) => {
        saves.push(body);
        return { approved: null, head: null, headError: null };
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const box = () => document.body.querySelector('#container-preview');

describe('ContainerPreviewBox save (C-12)', () => {
  it('goes away once the save worked, even when the refetch after it fails', async () => {
    await renderDom(createElement(ContainerPreviewBox, { project }), { path: '/projects/p1/settings' });
    await waitFor(() => expect(document.body.textContent).toContain('+preview: {}'));
    await click(getButton(USE_CONTAINER_PREVIEW_LABEL));
    await waitFor(() => expect(optionReads).toBeGreaterThan(1));
    expect(saves).toEqual([{ file: 'compose.yaml', service: 'web', port: 3000, baseSha256: null }]);
    await waitFor(() => expect(box()).toBeNull());
  });
});
