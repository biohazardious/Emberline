import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderStatic } from '../../staticRender';
import { ReferenceMaterial } from './ReferenceMaterial';
import { initialWizardState } from './wizardLogic';

describe('ReferenceMaterial', () => {
  it('says which files to add again and offers Dismiss', () => {
    const state = { ...initialWizardState(), materialsNotKept: ['a.png'] };
    const html = renderStatic(createElement(ReferenceMaterial, { state, dispatch: () => undefined }));
    expect(html).toContain('Files are not kept in the draft. Add them again: a.png.');
    expect(html).toContain('>Dismiss</button>');
  });
});
