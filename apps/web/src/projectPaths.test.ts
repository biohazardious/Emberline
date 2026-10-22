import { describe, expect, it } from 'vitest';
import { inActiveScope, projectIdFromPath, resolveActiveProject, resolveActiveProjectId, switchProjectPath } from './projectPaths';

describe('switchProjectPath', () => {
  it('keeps the page for every per-project route', () => {
    for (const page of ['board', 'roadmap', 'code', 'outputs', 'browser', 'settings']) {
      expect(switchProjectPath(`/projects/a1/${page}`, 'b2')).toBe(`/projects/b2/${page}`);
    }
    expect(switchProjectPath('/projects/a1/board/', 'b2')).toBe('/projects/b2/board/');
    expect(switchProjectPath('/projects/a1', 'b2')).toBe('/projects/b2');
  });
  it('drops the query and the hash', () => {
    expect(switchProjectPath('/projects/a1/outputs?run=r1', 'b2')).toBe('/projects/b2/outputs');
    expect(switchProjectPath('/projects/a1/settings?edit=worktree#x', 'b2')).toBe('/projects/b2/settings');
  });
  it('leaves the root and non-project paths alone', () => {
    for (const path of [
      '/',
      '/inbox',
      '/fleet',
      '/docker',
      '/settings',
      '/runs/r1/review',
      '/terminals/t1',
      '/projects',
      '/projects/',
    ]) {
      expect(switchProjectPath(path, 'b2')).toBeNull();
    }
  });
});

describe('projectIdFromPath', () => {
  it('reads the id of any per-project path', () => {
    expect(projectIdFromPath('/projects/a1/outputs')).toBe('a1');
    expect(projectIdFromPath('/projects/a1/settings?edit=worktree')).toBe('a1');
    expect(projectIdFromPath('/projects/a1')).toBe('a1');
    expect(projectIdFromPath('/inbox')).toBeNull();
    expect(projectIdFromPath('/runs/r1/review')).toBeNull();
  });
});

describe('resolveActiveProjectId', () => {
  const ids = ['p1', 'p2', 'p3'];
  it('prefers the URL, then the stored id, then the server, then the first project', () => {
    expect(resolveActiveProjectId(ids, { fromUrl: 'p3', stored: 'p2', server: 'p1' })).toBe('p3');
    expect(resolveActiveProjectId(ids, { fromUrl: null, stored: 'p2', server: 'p1' })).toBe('p2');
    expect(resolveActiveProjectId(ids, { fromUrl: null, stored: 'gone', server: 'p3' })).toBe('p3');
    expect(resolveActiveProjectId(ids, { fromUrl: null, stored: 'gone', server: 'gone-too' })).toBe('p1');
    expect(resolveActiveProjectId(ids, { fromUrl: null, stored: null, server: null })).toBe('p1');
  });
  it('waits for the server when nothing local is usable', () => {
    expect(resolveActiveProjectId(ids, { fromUrl: null, stored: 'gone', server: undefined })).toBeUndefined();
    expect(resolveActiveProjectId(ids, { fromUrl: null, stored: null, server: undefined })).toBeUndefined();
    expect(resolveActiveProjectId(ids, { fromUrl: null, stored: 'p2', server: undefined })).toBe('p2');
  });
  it('unknown URL project is ignored (Review Focus 1)', () => {
    expect(resolveActiveProjectId(ids, { fromUrl: 'deleted', stored: 'p2', server: 'p1' })).toBe('p2');
    expect(
      resolveActiveProjectId(ids, { fromUrl: 'deleted', stored: 'gone', server: undefined }),
    ).toBeUndefined();
  });
  it('null without projects', () => {
    expect(resolveActiveProjectId([], { fromUrl: 'p1', stored: 'p1', server: 'p1' })).toBeNull();
  });
});

describe('resolveActiveProject', () => {
  const ids = ['p1', 'p2'];
  it('a failed server read falls back to the first project without storing it', () => {
    expect(resolveActiveProject(ids, { fromUrl: null, stored: null, server: undefined, serverFailed: true })).toEqual({ id: 'p1', remember: false });
  });
  it('the URL wins at once and is stored', () => {
    expect(resolveActiveProject(ids, { fromUrl: 'p2', stored: 'p1', server: undefined, serverFailed: false })).toEqual({ id: 'p2', remember: true });
  });
  it('waits for the server', () => {
    expect(resolveActiveProject(ids, { fromUrl: null, stored: 'gone', server: undefined, serverFailed: false })).toEqual({ id: undefined, remember: true });
  });
});

describe('inActiveScope', () => {
  it('shows no runs while pending, all without projects, else the active project only', () => {
    expect(inActiveScope(undefined, 'p1')).toBe(false);
    expect(inActiveScope(null, 'p1')).toBe(true);
    expect(inActiveScope('p1', 'p1')).toBe(true);
    expect(inActiveScope('p1', 'p2')).toBe(false);
  });
});
