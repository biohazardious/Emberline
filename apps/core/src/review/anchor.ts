/** Re-anchoring of review comments after the code they were written about changed (pure). */

export const ANCHOR_WINDOW = 50;
export const ANCHOR_TEXT_MAX = 500;

/** The text stored as a comment's anchor: the commented line, trimmed and capped. */
export function anchorTextOf(lineText: string): string {
  return lineText.trim().slice(0, ANCHOR_TEXT_MAX);
}

export interface Anchored {
  currentLine: number | null;
  outdated: boolean;
}

/**
 * Finds where a comment's anchor text lives now. Order: the nearest match within ±50 lines of the
 * original line; else the single exact match anywhere in the file; else outdated.
 * Lines are 1-based.
 */
export function reanchor(line: number, anchorText: string, fileLines: readonly string[]): Anchored {
  const matches: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (anchorTextOf(fileLines[i]!) === anchorText) matches.push(i + 1);
  }
  let best: number | null = null;
  for (const m of matches) {
    const d = Math.abs(m - line);
    if (d > ANCHOR_WINDOW) continue;
    if (best === null || d < Math.abs(best - line)) best = m;
  }
  if (best !== null) return { currentLine: best, outdated: false };
  // One-character lines (`}`, `{`) say too little to be trusted across the whole file.
  if (matches.length === 1 && anchorText.length > 1) return { currentLine: matches[0]!, outdated: false };
  return { currentLine: null, outdated: true };
}
