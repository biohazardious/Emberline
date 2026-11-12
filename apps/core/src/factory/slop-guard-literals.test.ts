import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmTemp } from '../test-rm.js';
import { maskNonCode } from './code-mask.js';
import { auditWorktreeSlop } from './slop-guard.js';

describe('maskNonCode', () => {
  const tsx = (s: string) => maskNonCode(s, { jsx: true });
  const ts = (s: string) => maskNonCode(s, { jsx: false });

  it('blanks string and template text, keeps code, comments and line breaks', () => {
    const src = "const a = 'as any'; // TODO keep\nconst b = `x ${y as any} console.log(`;\n";
    const out = ts(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(out).not.toContain("'as any'");
    expect(out).toContain('// TODO keep');
    expect(out).toContain('y as any');
    expect(out).not.toContain('console.log(');
    const escaped = '"a\\"b console.log(" + c';
    expect(ts(escaped)).toBe(`"${' '.repeat('a\\"b console.log('.length)}" + c`);
  });

  it('blanks JSX text and attribute strings, keeps expressions', () => {
    const src = [
      'return (',
      '  <p className="x">',
      '    Never use <code>@ts-ignore</code> or <code>console.log</code>; no TODO.',
      '    {items.map((i) => <li key={i as any}>{i}</li>)}',
      '  </p>',
      ');',
    ].join('\n');
    const out = tsx(src);
    expect(out).not.toContain('@ts-ignore');
    expect(out).not.toContain('console.log');
    expect(out).not.toContain('TODO');
    expect(out).toContain('i as any');
    expect(out).toContain('items.map');
  });

  it('never reads comparisons, generics or regular expressions as JSX or strings', () => {
    expect(tsx('if (a < b && c > d) console.log(a);')).toContain('console.log(a)');
    expect(tsx('const [s] = useState<string>("x"); console.log(s);')).toContain('console.log(s)');
    expect(tsx('const id = <T,>(x: T) => x; console.log(id);')).toContain('console.log(id)');
    expect(tsx("const r = /'/g; console.log(r);")).toContain('console.log(r)');
    expect(ts('const t = <T>(x: T) => x; console.log(t);')).toContain('console.log(t)');
  });
});

describe('auditWorktreeSlop: literals and JSX text', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slop-literals-'));
    mkdirSync(path.join(dir, 'src'));
  });
  afterEach(() => rmTemp(dir));

  const categories = async () =>
    (await auditWorktreeSlop({ runId: 'r', workspacePath: dir })).issues.map(
      (i) => `${i.category}:${i.line}`,
    );

  it('UI copy and messages that name the scanned tokens are no finding', async () => {
    writeFileSync(
      path.join(dir, 'src/Copy.tsx'),
      [
        'export function Copy() {',
        '  return (',
        '    <p title="no : any here">',
        '      Scans for untyped casts (<code>: any</code>, <code>as any</code>), suppression directives',
        '      (<code>@ts-ignore</code>, <code>eslint-disable</code>), <code>TODO</code> stubs and leftover',
        '      <code>console.log</code> / <code>debugger</code> statements.',
        '    </p>',
        '  );',
        '}',
        "export const HINT = 'Remove // TODO markers and console.log() calls';",
        'export const tpl = `as any ${1} @ts-ignore`;',
        '',
      ].join('\n'),
    );
    expect(await categories()).toEqual([]);
  });

  it('the same tokens in code and in comments still count', async () => {
    writeFileSync(
      path.join(dir, 'src/real.ts'),
      [
        'export const x: any = 1;',
        '// @ts-ignore',
        'export const y = 2;',
        '// TODO: finish this',
        'console.log(x, y);',
        'export const z = `${x as any}`;',
        '',
      ].join('\n'),
    );
    expect(await categories()).toEqual([
      'type_evasion:1',
      'type_evasion:2',
      'unfinished_stub:4',
      'debug_leftover:5',
      'type_evasion:6',
    ]);
  });
});
