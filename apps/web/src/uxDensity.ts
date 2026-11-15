/**
 * Test-only density helper (`// @vitest-environment happy-dom`): counts the whitespace-separated
 * words of text a sighted user sees in the default view.
 */

function isSkippedElement(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.classList.contains('sr-only')) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') {
    return true;
  }
  if (tag === 'OPTION') {
    return !(el as HTMLOptionElement).selected;
  }
  return false;
}

function collectVisibleChunks(node: Node, chunks: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue?.trim();
    if (value) chunks.push(value);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  if (isSkippedElement(el)) return;

  const tag = el.tagName.toUpperCase();
  if (tag === 'DETAILS' && !el.hasAttribute('open') && !(el as HTMLDetailsElement).open) {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName.toUpperCase() === 'SUMMARY') {
        collectVisibleChunks(child, chunks);
      }
    }
    return;
  }

  for (const child of el.childNodes) {
    collectVisibleChunks(child, chunks);
  }
}

export function visibleText(root: Element): string {
  const chunks: string[] = [];
  collectVisibleChunks(root, chunks);
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export function visibleWordCount(root: Element): number {
  const text = visibleText(root);
  return text ? text.split(/\s+/).length : 0;
}
