import type { Project, WorktreeConfigStatusResponse } from '@emberline/protocol';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeConfigBanner } from './components/ProjectSettingsPanel';
import { renderStatic } from './staticRender';

// Monaco needs a browser; the editor is not rendered by the banner's first render.
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const project = { id: 'p1', name: 'Shop' } as Project;
const status = (o: Partial<WorktreeConfigStatusResponse> = {}): WorktreeConfigStatusResponse => ({
  approved: null,
  head: null,
  headError: null,
  changed: false,
  removed: false,
  diff: '',
  errors: [],
  unusable: false,
  ...o,
});
const url = '/api/projects/p1/worktree-config';
const html = (s: WorktreeConfigStatusResponse) =>
  renderStatic(createElement(WorktreeConfigBanner, { project }), { [url]: s }, '/projects/p1/board');

describe('WorktreeConfigBanner', () => {
  it('the Board banner offers Edit for an unusable file only', () => {
    expect(html(status({ changed: true, unusable: true, errors: ['x'] }))).toMatch(/<button[^>]*>Edit<\/button>/);
    expect(html(status({ changed: true, head: { content: 'x', sha256: 'a'.repeat(64) } }))).not.toMatch(
      />Edit<\/button>/,
    );
  });
});
