import { describe, expect, it } from 'vitest';
import { WorktreeConfig, WORKTREE_CONFIG_LIMITS } from './worktree-config.js';

const SPEC_EXAMPLE = {
  version: 1,
  copy: ['.env', { path: '.env.local', mode: 'symlink' }],
  setup: ['pnpm install --frozen-lockfile'],
  teardown: ['docker compose down'],
  services: [{ name: 'web', command: 'pnpm dev --port $PORT --host 0.0.0.0', preview: true }],
  checks: { build: 'pnpm build', lint: 'pnpm lint', test: 'pnpm test' },
};

const bad = (patch: Record<string, unknown>) => WorktreeConfig.safeParse({ version: 1, ...patch });

describe('WorktreeConfig v1', () => {
  it('accepts the spec example and defaults copy mode', () => {
    const out = WorktreeConfig.parse(SPEC_EXAMPLE);
    expect(out.services[0]?.preview).toBe(true);
    expect(out.checks.build).toBe('pnpm build');
  });
  it('accepts a minimal file', () => {
    const out = WorktreeConfig.parse({ version: 1 });
    expect(out).toMatchObject({ copy: [], setup: [], teardown: [], services: [], checks: {} });
  });
  it('requires version 1', () => {
    expect(WorktreeConfig.safeParse({}).success).toBe(false);
    expect(WorktreeConfig.safeParse({ version: 2 }).success).toBe(false);
  });
  it('rejects unknown keys', () => {
    expect(bad({ extra: 1 }).success).toBe(false);
    expect(bad({ checks: { deploy: 'x' } }).success).toBe(false);
  });
  it('limits lists to 20 entries', () => {
    expect(WORKTREE_CONFIG_LIMITS.maxEntries).toBe(20);
    const n = (k: number, f: (i: number) => unknown) => Array.from({ length: k }, (_, i) => f(i));
    expect(bad({ setup: n(20, () => 'a') }).success).toBe(true);
    expect(bad({ setup: n(21, () => 'a') }).success).toBe(false);
    expect(bad({ teardown: n(21, () => 'a') }).success).toBe(false);
    expect(bad({ copy: n(21, (i) => `f${i}`) }).success).toBe(false);
    expect(bad({ services: n(21, (i) => ({ name: `s${i}`, command: 'x' })) }).success).toBe(false);
  });
  it('limits commands to 2000 chars', () => {
    const ok = 'a'.repeat(2000);
    const tooLong = 'a'.repeat(2001);
    expect(bad({ setup: [ok] }).success).toBe(true);
    expect(bad({ setup: [tooLong] }).success).toBe(false);
    expect(bad({ teardown: [tooLong] }).success).toBe(false);
    expect(bad({ services: [{ name: 'w', command: tooLong }] }).success).toBe(false);
    expect(bad({ checks: { build: tooLong } }).success).toBe(false);
    expect(bad({ setup: [''] }).success).toBe(false);
  });
  it('rejects absolute, parent-escaping and malformed copy paths', () => {
    for (const p of ['/etc/passwd', '../x', 'a/../../x', 'a/..', '..', '~/x', 'C:\\x', '\\\\srv\\x', 'a\\..\\b', '', 'a\0b']) {
      expect(bad({ copy: [p] }).success, p).toBe(false);
      expect(bad({ copy: [{ path: p }] }).success, `obj ${p}`).toBe(false);
    }
    expect(bad({ copy: ['.env', 'config/local.json', 'a..b/c'] }).success).toBe(true);
  });
  it('rejects bad copy mode and duplicate or bad service names, and two preview services', () => {
    expect(bad({ copy: [{ path: '.env', mode: 'move' }] }).success).toBe(false);
    expect(bad({ services: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }).success).toBe(false);
    expect(bad({ services: [{ name: 'a b', command: 'x' }] }).success).toBe(false);
    expect(
      bad({ services: [{ name: 'a', command: 'x', preview: true }, { name: 'b', command: 'y', preview: true }] }).success,
    ).toBe(false);
  });
});
