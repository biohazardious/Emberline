// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Disclosure } from './components/ui/Disclosure';
import { cleanup, click, getButton, renderDom } from './domRender';
import { visibleText, visibleWordCount } from './uxDensity';

afterEach(cleanup);

describe('visibleWordCount', () => {
  it('counts whitespace-separated visible words across elements', () => {
    const div = document.createElement('div');
    div.innerHTML = '<h1>Settings</h1><p>Manage active providers and limits.</p>';
    expect(visibleText(div)).toBe('Settings Manage active providers and limits.');
    expect(visibleWordCount(div)).toBe(6);
  });

  it('returns 0 for empty or hidden roots', () => {
    const empty = document.createElement('div');
    expect(visibleWordCount(empty)).toBe(0);

    const hidden = document.createElement('div');
    hidden.setAttribute('hidden', '');
    hidden.textContent = 'Should not be counted';
    expect(visibleWordCount(hidden)).toBe(0);
  });

  it('skips [hidden], [aria-hidden="true"] and .sr-only subtrees', () => {
    const div = document.createElement('div');
    div.innerHTML = `
      <span>Visible title</span>
      <span hidden>Hidden text with four words</span>
      <span aria-hidden="true">★5 icon badge</span>
      <span class="sr-only">Screen reader only label</span>
      <div><p class="sr-only"><span>Nested screen reader text</span></p></div>
    `;
    expect(visibleText(div)).toBe('Visible title');
    expect(visibleWordCount(div)).toBe(2);
  });

  it('counts only the selected <option> inside a <select>', () => {
    const div = document.createElement('div');
    div.innerHTML = `
      <label>
        Quota policy
        <select>
          <option value="wait">Wait for reset</option>
          <option value="fallback" selected>Start on next route</option>
          <option value="stop">Cancel immediately</option>
        </select>
      </label>
    `;
    expect(visibleText(div)).toBe('Quota policy Start on next route');
    expect(visibleWordCount(div)).toBe(6);
  });

  it('skips non-summary content of a closed <details> and includes it when open', () => {
    const div = document.createElement('div');
    div.innerHTML = `
      <details>
        <summary>Advanced options</summary>
        <p>Extra explanation hidden until opened.</p>
        <div>More hidden words here</div>
      </details>
    `;
    expect(visibleText(div)).toBe('Advanced options');
    expect(visibleWordCount(div)).toBe(2);

    div.querySelector('details')!.setAttribute('open', '');
    expect(visibleWordCount(div)).toBe(11);
  });

  it('does not count closed Disclosure children until expanded', async () => {
    const { container } = await renderDom(
      createElement(
        'div',
        null,
        createElement('h1', null, 'Settings'),
        createElement(Disclosure, { label: 'Details' }, createElement('p', null, 'Four extra hidden words')),
      ),
    );
    expect(visibleWordCount(container)).toBe(2);

    await click(getButton('Details', container));
    expect(visibleWordCount(container)).toBe(6);
  });
});
