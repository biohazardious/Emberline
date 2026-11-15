// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Disclosure, HelpHint, MoreMenu, PageHeader, SaveBar, SettingRow, Switch } from './components/ui';
import { cleanup, click, getButton, queryButton, renderDom } from './domRender';

afterEach(cleanup);

function fireKey(target: Element | Document, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('Shared UI primitives', () => {
  describe('PageHeader', () => {
    it('renders a single h1 with optional subtitle, meta and actions', async () => {
      const { container } = await renderDom(
        createElement(PageHeader, {
          title: 'Settings',
          subtitle: 'Configure providers and limits.',
          meta: createElement('span', { className: 'badge' }, '5 active'),
          actions: createElement('button', { type: 'button', className: 'btn' }, 'Refresh'),
        }),
      );
      const headings = container.querySelectorAll('h1');
      expect(headings).toHaveLength(1);
      expect(headings[0]?.textContent).toBe('Settings');
      expect(container.textContent).toContain('Configure providers and limits.');
      expect(container.textContent).toContain('5 active');
      expect(getButton('Refresh', container)).toBeTruthy();
    });
  });

  describe('Switch', () => {
    it('exposes role="switch" and aria-checked, and toggles with click, Space and Enter', async () => {
      function Harness({ disabled = false, busy = false }: { disabled?: boolean; busy?: boolean }) {
        const [on, setOn] = useState(false);
        return createElement(Switch, {
          checked: on,
          onChange: setOn,
          label: 'Auto-pickup ready tickets',
          disabled,
          busy,
        });
      }

      const view = await renderDom(createElement(Harness));
      const sw = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
      expect(sw).not.toBeNull();
      expect(sw.getAttribute('aria-checked')).toBe('false');

      const labelId = sw.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      expect(view.container.querySelector(`#${CSS.escape(labelId!)}`)?.textContent).toBe(
        'Auto-pickup ready tickets',
      );

      await click(sw);
      expect(sw.getAttribute('aria-checked')).toBe('true');

      await act(async () => fireKey(sw, ' '));
      expect(sw.getAttribute('aria-checked')).toBe('false');

      await act(async () => fireKey(sw, 'Enter'));
      expect(sw.getAttribute('aria-checked')).toBe('true');

      await view.rerender(createElement(Harness, { disabled: true }));
      await click(sw);
      expect(sw.getAttribute('aria-checked')).toBe('true');

      await view.rerender(createElement(Harness, { busy: true }));
      expect(sw.getAttribute('aria-busy')).toBe('true');
      await act(async () => fireKey(sw, ' '));
      expect(sw.getAttribute('aria-checked')).toBe('true');
    });
  });

  describe('Disclosure', () => {
    it('renders no content while closed and toggles aria-expanded', async () => {
      const { container } = await renderDom(
        createElement(
          Disclosure,
          { label: 'Advanced details' },
          createElement('p', null, 'Hidden inner explanation'),
        ),
      );

      const trigger = getButton('Advanced details', container);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('Hidden inner explanation');

      await click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Hidden inner explanation');

      await click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('Hidden inner explanation');
    });
  });

  describe('HelpHint', () => {
    it('opens on Enter/Space, closes on Escape and outside click, and returns focus', async () => {
      const { container } = await renderDom(
        createElement(
          'div',
          null,
          createElement(HelpHint, { topic: 'quota policy' }, 'Wait pauses the project lane until reset.'),
          createElement('button', { type: 'button' }, 'Outside'),
        ),
      );

      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="About quota policy"]')!;
      expect(trigger).not.toBeNull();
      expect(trigger.hasAttribute('title')).toBe(false);
      expect(container.querySelector('[role="dialog"]')).toBeNull();

      trigger.focus();
      await act(async () => fireKey(trigger, 'Enter'));
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
        'Wait pauses the project lane until reset.',
      );

      await act(async () => fireKey(document, 'Escape'));
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => fireKey(trigger, ' '));
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();

      const outside = getButton('Outside', container);
      await act(async () => {
        outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  describe('SettingRow', () => {
    it('renders a labelled group with summary, disclosure details and right control slot', async () => {
      const { container } = await renderDom(
        createElement(SettingRow, {
          label: 'Self-healing build gate',
          summary: 'Runs build, lint and tests after each agent turn.',
          details: createElement('p', null, 'Resumes the agent once with failure output.'),
          control: createElement(Switch, {
            checked: true,
            onChange: () => undefined,
            ariaLabel: 'Self-healing build gate',
          }),
        }),
      );

      const group = container.querySelector('[role="group"]')!;
      expect(group).not.toBeNull();
      expect(container.textContent).toContain('Self-healing build gate');
      expect(container.textContent).toContain('Runs build, lint and tests after each agent turn.');
      expect(container.textContent).not.toContain('Resumes the agent once with failure output.');

      await click(getButton('Details', container));
      expect(container.textContent).toContain('Resumes the agent once with failure output.');
    });
  });

  describe('MoreMenu', () => {
    it('opens, moves focus with Arrow/Home/End keys, closes on Esc and returns focus', async () => {
      const onFirst = vi.fn();
      const onThird = vi.fn();
      const { container } = await renderDom(
        createElement(MoreMenu, {
          items: [
            { id: 'one', label: 'Update CLI', description: 'Fetch latest version', onSelect: onFirst },
            { id: 'two', label: 'Disabled action', disabled: true },
            { id: 'three', label: 'Uninstall CLI', danger: true, onSelect: onThird },
          ],
        }),
      );

      const trigger = getButton('More', container);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[role="menu"]')).toBeNull();

      trigger.focus();
      await click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');

      const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
      expect(menu).not.toBeNull();
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items).toHaveLength(3);
      expect(document.activeElement).toBe(items[0]);

      await act(async () => fireKey(menu, 'ArrowDown'));
      expect(document.activeElement).toBe(items[2]);

      await act(async () => fireKey(menu, 'ArrowDown'));
      expect(document.activeElement).toBe(items[0]);

      await act(async () => fireKey(menu, 'End'));
      expect(document.activeElement).toBe(items[2]);

      await act(async () => fireKey(menu, 'Home'));
      expect(document.activeElement).toBe(items[0]);

      await act(async () => fireKey(menu, 'ArrowUp'));
      expect(document.activeElement).toBe(items[2]);

      await act(async () => fireKey(menu, 'Escape'));
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await click(trigger);
      const reopenedItems = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      await click(reopenedItems[2]!);
      expect(onThird).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  describe('SaveBar', () => {
    it('renders nothing when clean and not saving, and exposes Discard and Save when dirty', async () => {
      const onDiscard = vi.fn();
      const view = await renderDom(createElement(SaveBar, { dirty: false, saving: false, onDiscard }));
      expect(view.container.querySelector('[role="status"]')).toBeNull();
      expect(queryButton('Save', view.container)).toBeNull();

      await view.rerender(createElement(SaveBar, { dirty: true, saving: false, onDiscard }));
      const status = view.container.querySelector('[role="status"]')!;
      expect(status).not.toBeNull();
      expect(status.textContent).toContain('Unsaved changes');

      const saveBtn = getButton('Save', view.container);
      expect(saveBtn.getAttribute('type')).toBe('submit');
      expect(saveBtn.classList.contains('btn-primary')).toBe(true);

      await click(getButton('Discard', view.container));
      expect(onDiscard).toHaveBeenCalledTimes(1);

      await view.rerender(createElement(SaveBar, { dirty: false, saving: true, onDiscard }));
      expect(getButton('Saving…', view.container).disabled).toBe(true);
    });
  });
});
