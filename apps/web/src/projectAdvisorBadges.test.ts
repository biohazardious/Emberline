import { describe, expect, it } from 'vitest';
import { stackBadgesOf } from './components/ProjectAdvisorPanel';

describe('stackBadgesOf', () => {
  it('shows each layer once, and never a layer left to the agent', () => {
    const agent = 'Decided by the agent. The Bootstrap ticket picks it and records it here.';
    expect(
      stackBadgesOf({
        language: 'TypeScript (Node.js)',
        frontend: agent,
        backend: agent,
        database: agent,
        styling: agent,
        testing: 'Vitest',
      }),
    ).toEqual(['TypeScript (Node.js)']);
    expect(
      stackBadgesOf({
        language: 'Go',
        frontend: 'React',
        backend: 'Go',
        database: '',
        styling: '',
        testing: '',
      }),
    ).toEqual(['Go', 'React']);
    expect(stackBadgesOf(null)).toEqual([]);
    expect(stackBadgesOf(undefined)).toEqual([]);
  });
});
