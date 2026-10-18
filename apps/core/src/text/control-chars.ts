/**
 * Text that core types into an agent's terminal must never carry terminal control sequences: an
 * ESC (or an 8-bit C1 control such as CSI, U+009B) inside a bracketed paste can end the paste and
 * turn the rest into keystrokes. Agent-controlled text (build output, file paths, code lines) reaches
 * prompts, so every C0 control except the allowed ones, DEL and every C1 control is removed.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** `text` without control characters; `keep` lists the ones allowed to stay (by default newline and tab). */
export function stripControlChars(text: string, keep = '\n\t'): string {
  return text.replace(CONTROLS, (ch) => (keep.includes(ch) ? ch : ''));
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair, marked with an ellipsis when cut. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, Math.max(0, end))}…`;
}
