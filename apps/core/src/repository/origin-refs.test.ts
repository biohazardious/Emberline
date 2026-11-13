import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { rmTemp } from '../test-rm.js';
import { tagCommitsHere } from './origin-refs.js';

let dir: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-C', dir, ...args], {
    encoding: 'utf8',
  }).trim();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'origin-refs-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git('commit', '-q', '--allow-empty', '-m', 'one');
});
afterEach(() => {
  setCommandExecutor(localCommandExecutor);
  rmTemp(dir);
});

describe('tagCommitsHere', () => {
  it('names the commit each tag finally names: lightweight, annotated, and a tag of a tag', async () => {
    const commit = git('rev-parse', 'HEAD');
    git('tag', 'light');
    git('tag', '-a', '-m', 'inner', 'inner');
    git('-c', 'advice.nestedTag=false', 'tag', '-a', '-m', 'outer', 'outer', 'inner');
    const inner = git('rev-parse', 'refs/tags/inner');
    // A git whose `%(*…)` peels one level only (as older ones did): the outer tag reads as the inner tag.
    setCommandExecutor(async (request) => {
      const result = await localCommandExecutor(request);
      if (!request.args.includes('for-each-ref') || !request.args.some((a) => a.includes('%(*objectname)')))
        return result;
      const stdout = String(result.stdout)
        .split('\n')
        .map((line) => {
          const fields = line.split('\0');
          if (fields[0] !== 'refs/tags/outer') return line;
          return [fields[0], fields[1], inner, 'tag', ...fields.slice(4)].join('\0');
        })
        .join('\n');
      return { ...result, stdout };
    });
    const commits = await tagCommitsHere(dir);
    expect(Object.fromEntries(commits)).toEqual({ light: commit, inner: commit, outer: commit });
  });
});
