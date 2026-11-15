/**
 * Plain text of a ptyd snapshot, laid out as the terminal shows it. A snapshot is xterm's serialized
 * screen: blank cells come out as cursor moves (`CSI n C`) and erases (`CSI n X`), not spaces, so
 * stripping the escapes would glue columns together ("Opus" + gap + "Most capable" → "OpusMost
 * capable") and drop indentation. This replays the snapshot onto a grid instead, for the sequences
 * the serializer writes: text with wrapping, CR/LF, cursor moves and positioning, erase-character,
 * and the switch to the alternate screen (whose content then replaces the normal screen's). Colours
 * and modes are ignored.
 */

/** Terminal columns a code point takes: 0 for combining marks, 2 for wide (CJK, emoji), else 1. */
function widthOf(cp: number): number {
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function screenTextOf(data: string, cols: number): string {
  let grid: string[][] = [];
  let row = 0;
  let col = 0;
  const line = (r: number) => (grid[r] ??= []);
  const put = (r: number, c: number, ch: string) => {
    const cells = line(r);
    while (cells.length < c) cells.push(' ');
    cells[c] = ch;
  };

  const chars = [...data];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '\x1b') {
      const next = chars[i + 1];
      if (next === '[') {
        let j = i + 2;
        let params = '';
        while (j < chars.length && !/[@-~]/.test(chars[j]!)) params += chars[j++];
        const final = chars[j];
        i = j;
        const nums = params.replace(/^[?>=!]/, '').split(';');
        const n = Math.max(1, Number.parseInt(nums[0] ?? '', 10) || 1);
        if (params.startsWith('?')) {
          // The serializer appends the alternate screen after the normal one; only it is visible.
          if (final === 'h' && /(^|;)(1049|47|1047)(;|$)/.test(params.slice(1))) {
            grid = [];
            row = 0;
            col = 0;
          }
          continue;
        }
        if (final === 'C') col = Math.min(cols - 1, col + n);
        else if (final === 'D') col = Math.max(0, col - n);
        else if (final === 'A') row = Math.max(0, row - n);
        else if (final === 'B') row += n;
        else if (final === 'G') col = Math.min(cols - 1, n - 1);
        else if (final === 'H' || final === 'f') {
          row = Math.max(1, Number.parseInt(nums[0] ?? '', 10) || 1) - 1;
          col = Math.min(cols - 1, Math.max(1, Number.parseInt(nums[1] ?? '', 10) || 1) - 1);
        } else if (final === 'X') {
          for (let c = col; c < Math.min(cols, col + n); c++)
            if (line(row)[c] !== undefined) put(row, c, ' ');
        }
        continue;
      }
      if (next === ']') {
        // OSC: up to BEL or ST.
        let j = i + 2;
        while (j < chars.length && chars[j] !== '\x07' && !(chars[j] === '\x1b' && chars[j + 1] === '\\'))
          j++;
        i = chars[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      // Charset selection takes one more character; other escapes are two characters long.
      i += next === '(' || next === ')' ? 2 : 1;
      continue;
    }
    if (ch === '\r') col = 0;
    else if (ch === '\n') row += 1;
    else if (ch === '\b') col = Math.max(0, col - 1);
    else if (ch === '\t') col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
    else if (ch >= ' ' && ch !== '\x7f') {
      const width = widthOf(ch.codePointAt(0)!);
      if (width === 0) {
        const cells = line(row);
        if (col > 0 && cells[col - 1] !== undefined) cells[col - 1] += ch;
        continue;
      }
      if (col + width > cols) {
        row += 1;
        col = 0;
      }
      put(row, col, ch);
      // A wide character's second cell holds nothing, so the text keeps one character for it.
      if (width === 2) put(row, col + 1, '');
      col += width;
    }
  }

  const lines: string[] = [];
  for (let r = 0; r < grid.length; r++)
    lines.push(
      (grid[r] ?? [])
        .map((c) => c ?? ' ')
        .join('')
        .trimEnd(),
    );
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}
