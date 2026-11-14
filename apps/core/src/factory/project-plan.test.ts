import { describe, expect, it } from 'vitest';
import { techStackFromChoices } from './project-plan.js';

describe('techStackFromChoices', () => {
  it('writes no stack text for a layer left to the agent or with none', () => {
    const stack = techStackFromChoices({ language: 'typescript-node', frontend: 'agent', backend: 'none' });
    expect(stack.frontend).toBe('');
    expect(stack.backend).toBe('');
    expect(stack.database).toBe('');
    expect(stack.language).not.toBe('');
  });
});
