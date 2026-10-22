import { describe, expect, it } from 'vitest';
import { projectDeleteChoices } from './projectDelete';

const project = { id: 'p1', name: 'Shop', path: '/workspaces/shop' };

describe('projectDeleteChoices', () => {
  it('"Remove from Emberline" keeps the files; only "Remove and delete files" deletes them', () => {
    const { keep, purge } = projectDeleteChoices({ ...project, importSource: 'new' });
    expect(keep).toMatchObject({ label: 'Remove from Emberline', url: '/api/projects/p1?deleteFiles=0' });
    expect(keep.description).toContain('/workspaces/shop stays');
    expect(purge).toMatchObject({ label: 'Remove and delete files', url: '/api/projects/p1?deleteFiles=1' });
    expect(purge.description).toContain('deletes the workspace folder /workspaces/shop');
  });

  it('warns that deleting a folder import deletes the repository folder', () => {
    const { purge } = projectDeleteChoices({ ...project, importSource: 'folder' });
    expect(purge.description).toContain('this deletes your repository folder /workspaces/shop');
  });

  it('a project from before the source was recorded gets the plain wording', () => {
    expect(projectDeleteChoices({ ...project, importSource: undefined }).purge.description).not.toContain(
      'repository folder',
    );
  });
});
