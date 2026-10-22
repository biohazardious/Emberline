import { describe, expect, it } from 'vitest';
import {
  choiceForService,
  containerPreviewBoxShown,
  containerPreviewIntro,
  containerPreviewSaveEnabled,
  containerPreviewSettingsHref,
  declaredPortsLine,
  defaultContainerPreviewChoice,
  parsePort,
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
