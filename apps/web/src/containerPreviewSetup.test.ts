import { describe, expect, it } from 'vitest';
import {
  ANCHOR_HOLD_MS,
  anchorHoldActive,
  anchorScrollDue,
  choiceForService,
  containerPreviewBoxShown,
  containerPreviewHint,
  containerPreviewHintKey,
  containerPreviewHintShown,
  containerPreviewIntro,
  containerPreviewSaveEnabled,
  containerPreviewSettingsHref,
  declaredPortsLine,
  defaultContainerPreviewChoice,
  parsePort,
  portProblem,
  readHintDismissed,
  writeHintDismissed,
} from './containerPreviewSetup';

const off = { available: false, reason: 'x', file: null, services: [], commandPreview: true };

describe('containerPreviewBoxShown', () => {
  it('shows the box exactly when core names a file', () => {
    expect(containerPreviewBoxShown(undefined)).toBe(false);
    expect(containerPreviewBoxShown(off)).toBe(false);
    expect(containerPreviewBoxShown({ ...off, file: 'compose.yaml' })).toBe(true); // with a reason: shown, cannot save
    expect(containerPreviewBoxShown({ ...off, available: true, reason: null, file: 'compose.yml' })).toBe(
      true,
    );
  });
});

describe('defaultContainerPreviewChoice', () => {
  it('web first, else the first service with a port; its first port', () => {
    expect(
      defaultContainerPreviewChoice([
        { name: 'db', ports: [5432] },
        { name: 'web', ports: [8080, 9229] },
      ]),
    ).toEqual({ service: 'web', port: 8080 });
    expect(
      defaultContainerPreviewChoice([
        { name: 'worker', ports: [] },
        { name: 'app', ports: [3000] },
      ]),
    ).toEqual({ service: 'app', port: 3000 });
    expect(
      defaultContainerPreviewChoice([
        { name: 'web', ports: [] },
        { name: 'app', ports: [3000] },
      ]),
    ).toEqual({ service: 'web', port: null });
    expect(defaultContainerPreviewChoice([{ name: 'worker', ports: [] }])).toEqual({
      service: 'worker',
      port: null,
    });
    expect(defaultContainerPreviewChoice([])).toBeNull();
  });
  it('another service takes its own first port', () => {
    const services = [
      { name: 'web', ports: [8080] },
      { name: 'db', ports: [5432] },
      { name: 'job', ports: [] },
    ];
    expect(choiceForService(services, 'db')).toEqual({ service: 'db', port: 5432 });
    expect(choiceForService(services, 'job')).toEqual({ service: 'job', port: null });
  });
});

describe('parsePort and saving', () => {
  it('takes whole ports 1-65535 only', () => {
    expect(parsePort('8080')).toBe(8080);
    for (const bad of ['', ' ', '0', '65536', '80.5', 'abc', '-1']) expect(parsePort(bad)).toBeNull();
  });
  it('saves only with a service, a port and a shown diff, and not twice', () => {
    expect(
      containerPreviewSaveEnabled({ draft: { service: 'web', port: 8080 }, diffReady: true, busy: false }),
    ).toBe(true);
    expect(
      containerPreviewSaveEnabled({ draft: { service: 'web', port: null }, diffReady: true, busy: false }),
    ).toBe(false);
    expect(
      containerPreviewSaveEnabled({ draft: { service: 'web', port: 8080 }, diffReady: false, busy: false }),
    ).toBe(false);
    expect(
      containerPreviewSaveEnabled({ draft: { service: 'web', port: 8080 }, diffReady: true, busy: true }),
    ).toBe(false);
    expect(containerPreviewSaveEnabled({ draft: null, diffReady: true, busy: false })).toBe(false);
  });
});

describe('copy', () => {
  it('says what the box does and what the service declares', () => {
    expect(containerPreviewIntro('compose.yaml')).toBe(
      'Preview this project with a service of compose.yaml in the Docker engine instead of a command. Emberline publishes the container port itself.',
    );
    expect(declaredPortsLine('web', [8080])).toBe('web declares port 8080.');
    expect(declaredPortsLine('web', [8080, 9229])).toBe('web declares ports 8080, 9229.');
    expect(declaredPortsLine('job', [])).toBe('job declares no port. Enter the one its app listens on.');
    expect(containerPreviewSettingsHref('p1')).toBe('/projects/p1/settings#container-preview');
  });
});

describe('portProblem', () => {
  it('names why the port cannot be used, and is silent for a good one', () => {
    expect(portProblem('8080')).toBeNull();
    for (const bad of ['', '0', '65536', '80.5', 'abc'])
      expect(portProblem(bad)).toBe('Enter a port from 1 to 65535.');
  });
});

describe('the Preview & Build hint', () => {
  const offer = {
    available: true,
    reason: null,
    file: 'compose.yaml' as const,
    services: [{ name: 'web', ports: [8080] }],
    commandPreview: true,
  };
  const main = { kind: 'main' };
  const run = { kind: 'run' };

  it('shows for a command preview while the box is offered', () => {
    expect(containerPreviewHintShown(offer, main, { kind: 'compose' }, false)).toBe(true); // main's status is always kind compose
    expect(containerPreviewHintShown(offer, run, { kind: 'command' }, false)).toBe(true);
    expect(
      containerPreviewHintShown({ ...offer, available: false, reason: 'x' }, run, { kind: 'command' }, false),
    ).toBe(true);
  });
  it('hides when dismissed, without a box, without a command preview, or for a run already on a compose preview', () => {
    expect(containerPreviewHintShown(offer, run, { kind: 'command' }, true)).toBe(false);
    expect(containerPreviewHintShown({ ...offer, file: null }, run, { kind: 'command' }, false)).toBe(false);
    expect(
      containerPreviewHintShown({ ...offer, commandPreview: false }, run, { kind: 'command' }, false),
    ).toBe(false);
    expect(containerPreviewHintShown(offer, run, { kind: 'compose' }, false)).toBe(false);
    expect(containerPreviewHintShown(undefined, run, { kind: 'command' }, false)).toBe(false);
  });
  it('is the spec line', () => {
    expect(containerPreviewHint('compose.yaml')).toEqual({
      text: 'This project has compose.yaml.',
      link: 'Preview it in a container instead',
    });
  });
});

describe('hint dismissal storage (Review Focus 5)', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  it('is per project', () => {
    const s = memory();
    writeHintDismissed('a', s);
    expect(readHintDismissed('a', s)).toBe(true);
    expect(readHintDismissed('b', s)).toBe(false);
    expect(s.getItem(containerPreviewHintKey('a'))).toBe('1');
    expect(containerPreviewHintKey('a')).toBe('emberline.containerPreviewHint.dismissed.a');
  });
  it('never throws without storage', () => {
    expect(readHintDismissed('a', throwing)).toBe(false);
    expect(() => writeHintDismissed('a', throwing)).not.toThrow();
    expect(readHintDismissed('a', null)).toBe(false);
    expect(() => writeHintDismissed('a', null)).not.toThrow();
  });
});

describe('anchorScrollDue', () => {
  const v = { scrolled: false, shown: true, fetching: 0, hash: '#forge-accounts', anchor: 'forge-accounts' };
  it('waits for loads to settle and scrolls once', () => {
    expect(anchorScrollDue({ ...v, fetching: 1 })).toBe(false);
    expect(anchorScrollDue(v)).toBe(true);
    expect(anchorScrollDue({ ...v, scrolled: true })).toBe(false);
    expect(anchorScrollDue({ ...v, shown: false })).toBe(false);
    expect(anchorScrollDue({ ...v, hash: '#other' })).toBe(false);
  });
});

describe('anchorHoldActive', () => {
  const v = { elapsedMs: 100, userScrolled: false, hash: '#forge-accounts', anchor: 'forge-accounts' };
  it('keeps the box in view while the layout settles, until the time is up, the reader scrolls or the hash changes', () => {
    expect(anchorHoldActive(v)).toBe(true);
    expect(anchorHoldActive({ ...v, elapsedMs: ANCHOR_HOLD_MS - 1 })).toBe(true);
    expect(anchorHoldActive({ ...v, elapsedMs: ANCHOR_HOLD_MS })).toBe(false);
    expect(anchorHoldActive({ ...v, userScrolled: true })).toBe(false);
    expect(anchorHoldActive({ ...v, hash: '' })).toBe(false);
  });
});
