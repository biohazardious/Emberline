import type { ContainerPreviewOptionsResponse, Project } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerPreviewBox } from './components/ContainerPreviewBox';
import { ContainerPreviewHint } from './components/PreviewAndBuildView';
import { containerPreviewHintKey } from './containerPreviewSetup';
import { renderStatic } from './staticRender';

const project = { id: 'p1', name: 'Shop' } as Project;
const url = '/api/projects/p1/container-preview';
const options = (o: Record<string, unknown>) => o as unknown as ContainerPreviewOptionsResponse;
const box = (o: Record<string, unknown>) =>
  renderStatic(createElement(ContainerPreviewBox, { project }), { [url]: options(o) }, '/projects/p1/settings');

beforeEach(() => {
  vi.stubGlobal('window', { location: { hash: '', protocol: 'http:' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('ContainerPreviewBox', () => {
  it('renders nothing without a compose file', () => {
    expect(box({ available: false, reason: 'x', file: null, services: [], commandPreview: true })).toBe('');
  });

  it('explains an unavailable engine without the fields', () => {
    const html = box({
      available: false,
      reason: 'Docker is not available.',
      file: 'compose.yaml',
      services: [],
      commandPreview: true,
    });
    expect(html).toContain('id="container-preview"');
    expect(html).toContain('Docker is not available.');
    expect(html).not.toContain('Container port');
  });

  it('lists the services of an available file', () => {
    const html = box({
      available: true,
      file: 'compose.yaml',
      services: [
        { name: 'web', ports: [3000] },
        { name: 'db', ports: [] },
      ],
      commandPreview: true,
    });
    expect(html).toContain('<option value="web">web</option>');
    expect(html).toContain('<option value="db">db</option>');
  });
});

describe('ContainerPreviewHint', () => {
  const hint = () =>
    renderStatic(
      createElement(ContainerPreviewHint, {
        projectId: 'p1',
        target: { id: 'main', kind: 'main' } as never,
        preview: undefined,
      }),
      { [url]: options({ available: true, file: 'compose.yaml', services: [], commandPreview: true }) },
      '/projects/p1/board',
    );

  it('points to Project settings and can be dismissed', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
    const html = hint();
    expect(html).toContain('This project has compose.yaml.');
    expect(html).toContain('href="/projects/p1/settings#container-preview"');
    expect(html).toContain('>Dismiss</button>');
  });

  it('stays hidden once dismissed', () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === containerPreviewHintKey('p1') ? '1' : null),
      setItem() {},
    });
    expect(hint()).toBe('');
  });
});
