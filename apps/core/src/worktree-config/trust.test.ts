import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreeCommandsMissing } from './trust.js';
import { rmTemp } from '../test-rm.js';

describe('worktreeCommandsMissing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wt-commands-'));
  });
  afterEach(() => rmTemp(dir));
  const write = (text: string) => {
    mkdirSync(path.join(dir, '.emberline'), { recursive: true });
    writeFileSync(path.join(dir, '.emberline/worktree.yml'), text);
  };

  it('a missing file is reported', async () => {
    expect(await worktreeCommandsMissing(dir)).toContain('is missing');
  });
  it('a file with only a version has none', async () => {
    write('version: 1\n');
    expect(await worktreeCommandsMissing(dir)).toContain('has no setup, services or checks');
  });
  it('copy and teardown do not count', async () => {
    write('version: 1\ncopy:\n  - .env\nteardown:\n  - "true"\n');
    expect(await worktreeCommandsMissing(dir)).toContain('has no setup, services or checks');
  });
  it('empty checks do not count', async () => {
    write('version: 1\nchecks: {}\n');
    expect(await worktreeCommandsMissing(dir)).toContain('has no setup, services or checks');
  });
  it('a setup command counts', async () => {
    write('version: 1\nsetup:\n  - "true"\n');
    expect(await worktreeCommandsMissing(dir)).toBeNull();
  });
  it("an invalid file is the other gate's job", async () => {
    write('version: 1\nchecks:\n  container: x\n');
    expect(await worktreeCommandsMissing(dir)).toBeNull();
  });
  it("a symbolic link is the other gate's job", async () => {
    writeFileSync(path.join(dir, 'elsewhere.yml'), 'version: 1\n');
    mkdirSync(path.join(dir, '.emberline'), { recursive: true });
    symlinkSync('../elsewhere.yml', path.join(dir, '.emberline/worktree.yml'));
    expect(await worktreeCommandsMissing(dir)).toBeNull();
  });
});
