import { describe, expect, it } from 'vitest';
import { holdLabelOf, PROVIDER_REGISTRY, worktreeCheckOf } from './runs.js';

describe('PROVIDER_REGISTRY terms', () => {
  it('every provider carries a dated terms note with an https link and a risk level', () => {
    for (const entry of Object.values(PROVIDER_REGISTRY)) {
      const { terms } = entry;
      expect(terms, entry.id).toBeDefined();
      expect(terms.url, entry.id).toMatch(/^https:\/\//);
      expect(terms.checked, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(terms.checked)), entry.id).toBe(false);
      expect(['low', 'medium', 'high'], entry.id).toContain(terms.risk);
      expect(terms.summary.length, entry.id).toBeGreaterThan(0);
    }
  });
});

describe('worktreeCheckOf', () => {
  it('tells the worktree checks apart by their check field, and older notes by their output', () => {
    expect(worktreeCheckOf('build_gate_failed', { check: 'worktree_yml' })).toBe('worktree_yml');
    expect(worktreeCheckOf('build_gate_failed', { check: 'worktree_commands' })).toBe('worktree_commands');
    expect(worktreeCheckOf('build_gate_failed', { output: '.emberline/worktree.yml is not valid:\nx' })).toBe(
      'worktree_yml',
    );
    expect(worktreeCheckOf('build_gate_failed', { check: 'build', output: 'tsc failed' })).toBeNull();
    expect(worktreeCheckOf('merge_conflict', { check: 'worktree_yml' })).toBeNull();
    expect(worktreeCheckOf('build_gate_failed', null)).toBeNull();
  });

  it('the labels follow the check', () => {
    expect(holdLabelOf('build_gate_failed', { check: 'worktree_yml' })).toBe('Worktree config is not valid');
    expect(holdLabelOf('build_gate_failed', { check: 'worktree_commands' })).toBe(
      'Worktree commands are missing',
    );
  });
});
