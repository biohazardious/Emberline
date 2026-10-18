/** A small line diff for the worktree.yml review: approved content -> HEAD's. */

const CONTEXT = 3;
/** Longest diff returned; the rest is cut with a note. */
export const MAX_DIFF_CHARS = 64 * 1024;
/** Above this many LCS cells the changed middle is shown as removed then added, unaligned. */
const MAX_LCS_CELLS = 4_000_000;

type Op = { kind: ' ' | '-' | '+'; text: string };

const linesOf = (text: string) => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

function lineOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): Op => ({ kind: ' ', text }));
  const tail = a.slice(endA).map((text): Op => ({ kind: ' ', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const mid: Op[] = [];
  if (n * m > MAX_LCS_CELLS) {
    for (const text of midA) mid.push({ kind: '-', text });
    for (const text of midB) mid.push({ kind: '+', text });
    return [...head, ...mid, ...tail];
  }
  // lcs[i][j]: LCS length of midA[i..] and midB[j..], one flat array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      mid.push({ kind: ' ', text: midA[i]! });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
      mid.push({ kind: '+', text: midB[j]! });
      j++;
    } else {
      mid.push({ kind: '-', text: midA[i]! });
      i++;
    }
  }
  return [...head, ...mid, ...tail];
}

/**
 * Unified diff (3 lines of context) from `before` (approved) to `after` (HEAD); empty when equal.
 * Bounded to {@link MAX_DIFF_CHARS}: a longer one ends with a "diff truncated" line.
 */
export function unifiedDiff(before: string, after: string, labels = { before: 'approved', after: 'HEAD' }): string {
  if (before === after) return '';
  const ops = lineOps(linesOf(before), linesOf(after));
  const out: string[] = [`--- ${labels.before}`, `+++ ${labels.after}`];
  let size = out[0]!.length + out[1]!.length + 2;
  let k = 0;
  // Line numbers (1-based) in before/after at ops[k].
  let lineA = 1;
  let lineB = 1;
  const advance = (op: Op) => {
    if (op.kind !== '+') lineA++;
    if (op.kind !== '-') lineB++;
  };
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.kind === ' ') advance(ops[k++]!);
    if (k >= ops.length) break;
    // Hunk: from CONTEXT lines before the change to CONTEXT lines after the last change within reach.
    let from = k;
    let fromA = lineA;
    let fromB = lineB;
    for (let c = 0; c < CONTEXT && from > 0 && ops[from - 1]!.kind === ' '; c++) {
      from--;
      fromA--;
      fromB--;
    }
    let to = k;
    let lastChange = k;
    while (to < ops.length) {
      if (ops[to]!.kind !== ' ') lastChange = to;
      else if (to - lastChange > 2 * CONTEXT) break;
      to++;
    }
    to = Math.min(ops.length, lastChange + CONTEXT + 1);
    const hunk = ops.slice(from, to);
    const countA = hunk.filter((op) => op.kind !== '+').length;
    const countB = hunk.filter((op) => op.kind !== '-').length;
    const lines = [
      `@@ -${countA === 0 ? fromA - 1 : fromA},${countA} +${countB === 0 ? fromB - 1 : fromB},${countB} @@`,
      ...hunk.map((op) => `${op.kind}${op.text}`),
    ];
    for (const line of lines) {
      if (size + line.length + 1 > MAX_DIFF_CHARS) {
        out.push('… diff truncated');
        return `${out.join('\n')}\n`;
      }
      out.push(line);
      size += line.length + 1;
    }
    for (let x = k; x < to; x++) advance(ops[x]!);
    k = to;
  }
  return `${out.join('\n')}\n`;
}
