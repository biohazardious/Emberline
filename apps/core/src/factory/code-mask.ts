/**
 * What of a JavaScript / TypeScript source is code to the slop guard: the text of string and
 * template literals and of JSX is blanked (spaces; line breaks stay, so line numbers do not move),
 * comments and everything else are kept. A `console.log` or `@ts-ignore` written as UI copy or in a
 * message is then no finding, while the same token in code or in a comment still is.
 *
 * A small lexer, not a parser: a `<` starts JSX only where an expression may start (after `(`, `=`,
 * `return` and the like), and a `/` starts a regular expression likewise; regular expressions are
 * kept as written. Generic type arguments (`useState<string>(…)`, `<T,>(x) =>`) are never JSX.
 */

const IDENT = /[A-Za-z0-9_$]/;
/** Words after which an expression starts: a `<` there opens JSX, a `/` a regular expression. */
const EXPRESSION_KEYWORDS = new Set([
  'return',
  'yield',
  'await',
  'default',
  'case',
  'else',
  'do',
  'typeof',
  'void',
  'delete',
  'in',
  'of',
  'new',
  'throw',
  'instanceof',
]);

class Masker {
  private readonly out: string[];
  private i = 0;
  /** The last significant character of code (not a space, not in a comment). */
  private lastChar = '';
  /** The identifier or keyword that ended at lastChar, if any. */
  private lastWord = '';

  constructor(
    private readonly src: string,
    private readonly jsx: boolean,
  ) {
    // UTF-16 code units, as the indexes below count them (a spread would split by code points).
    this.out = src.split('');
  }

  run(): string {
    this.code(null);
    return this.out.join('');
  }

  private blank(at: number): void {
    const ch = this.src[at];
    if (ch !== undefined && ch !== '\n' && ch !== '\r') this.out[at] = ' ';
  }

  private peek(offset = 0): string {
    return this.src[this.i + offset] ?? '';
  }

  /** Whether an expression may start here (decides JSX and regular expressions). */
  private expressionStarts(): boolean {
    if (this.lastChar === '') return true;
    if (IDENT.test(this.lastChar)) return EXPRESSION_KEYWORDS.has(this.lastWord);
    return !')]}\'"`'.includes(this.lastChar);
  }

  private note(ch: string): void {
    if (IDENT.test(ch)) {
      this.lastWord = IDENT.test(this.lastChar) ? this.lastWord + ch : ch;
    } else {
      this.lastWord = '';
    }
    this.lastChar = ch;
  }

  /** Code up to the `}` that closes it when `close` is set (consumed), else to the end. */
  private code(close: '}' | null): void {
    let depth = 0;
    while (this.i < this.src.length) {
      const ch = this.peek();
      const next = this.peek(1);
      if (ch === '/' && next === '/') {
        this.skipLineComment();
        continue;
      }
      if (ch === '/' && next === '*') {
        this.skipBlockComment();
        continue;
      }
      if (ch === "'" || ch === '"') {
        this.string(ch);
        this.note(ch);
        continue;
      }
      if (ch === '`') {
        this.template();
        this.note('`');
        continue;
      }
      if (ch === '/' && this.expressionStarts()) {
        this.regex();
        this.note(')');
        continue;
      }
      if (ch === '<' && this.jsx && this.expressionStarts() && this.jsxStartsHere()) {
        this.element();
        this.note(')');
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        if (close && depth === 0) {
          this.i += 1;
          return;
        }
        depth -= 1;
      }
      if (!/\s/.test(ch)) this.note(ch);
      this.i += 1;
    }
  }

  private skipLineComment(): void {
    while (this.i < this.src.length && this.peek() !== '\n') this.i += 1;
  }

  private skipBlockComment(): void {
    const end = this.src.indexOf('*/', this.i + 2);
    this.i = end === -1 ? this.src.length : end + 2;
  }

  /** A quoted string: its content is blanked, the quotes stay. */
  private string(quote: string): void {
    this.i += 1;
    while (this.i < this.src.length) {
      const ch = this.peek();
      if (ch === '\\') {
        this.blank(this.i);
        this.blank(this.i + 1);
        this.i += 2;
        continue;
      }
      if (ch === quote) {
        this.i += 1;
        return;
      }
      // An unterminated string ends at the line break (as the engine reports it).
      if (ch === '\n') return;
      this.blank(this.i);
      this.i += 1;
    }
  }

  /** A template literal: its text is blanked, each `${…}` is code. */
  private template(): void {
    this.i += 1;
    while (this.i < this.src.length) {
      const ch = this.peek();
      if (ch === '\\') {
        this.blank(this.i);
        this.blank(this.i + 1);
        this.i += 2;
        continue;
      }
      if (ch === '`') {
        this.i += 1;
        return;
      }
      if (ch === '$' && this.peek(1) === '{') {
        this.i += 2;
        this.lastChar = '{';
        this.lastWord = '';
        this.code('}');
        continue;
      }
      this.blank(this.i);
      this.i += 1;
    }
  }

  /** A regular expression literal, kept as written (a `/` in a class does not end it). */
  private regex(): void {
    this.i += 1;
    let inClass = false;
    while (this.i < this.src.length) {
      const ch = this.peek();
      if (ch === '\n') return;
      if (ch === '\\') {
        this.i += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        this.i += 1;
        while (IDENT.test(this.peek())) this.i += 1;
        return;
      }
      this.i += 1;
    }
  }

  /** `<` followed by a tag name or `>` (a fragment), and not a type parameter list (`<T,>`, `<T extends …>`). */
  private jsxStartsHere(): boolean {
    const rest = this.src.slice(this.i + 1, this.i + 200);
    if (rest.startsWith('>')) return true;
    const m = /^[A-Za-z_$][\w$.:-]*(\s*)/.exec(rest);
    if (!m) return false;
    const after = rest.slice(m[0].length);
    return !after.startsWith(',') && !(m[1] !== '' && /^extends\b/.test(after));
  }

  /** A JSX element from its `<` to the end of its closing tag (or `/>`). */
  private element(): void {
    this.i += 1; // <
    // The tag name.
    while (this.i < this.src.length && /[\w$.:-]/.test(this.peek())) this.i += 1;
    // Attributes, up to `>` or `/>`.
    while (this.i < this.src.length) {
      const ch = this.peek();
      if (ch === '/' && this.peek(1) === '>') {
        this.i += 2;
        return;
      }
      if (ch === '>') {
        this.i += 1;
        break;
      }
      if (ch === '"' || ch === "'") {
        this.string(ch);
        continue;
      }
      if (ch === '{') {
        this.i += 1;
        this.lastChar = '{';
        this.lastWord = '';
        this.code('}');
        continue;
      }
      this.i += 1;
    }
    this.children();
  }

  /** An element's children, up to and including its closing tag: text blanked, `{…}` is code. */
  private children(): void {
    while (this.i < this.src.length) {
      const ch = this.peek();
      if (ch === '<') {
        if (this.peek(1) === '/') {
          const end = this.src.indexOf('>', this.i);
          this.i = end === -1 ? this.src.length : end + 1;
          return;
        }
        this.element();
        continue;
      }
      if (ch === '{') {
        this.i += 1;
        this.lastChar = '{';
        this.lastWord = '';
        this.code('}');
        continue;
      }
      this.blank(this.i);
      this.i += 1;
    }
  }
}

/** `source` with string, template and (with `jsx`) JSX text blanked; same length and line breaks. */
export function maskNonCode(source: string, options: { jsx: boolean }): string {
  return new Masker(source, options.jsx).run();
}
