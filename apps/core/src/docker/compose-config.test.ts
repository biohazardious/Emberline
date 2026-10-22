import { describe, expect, it } from 'vitest';
import {
  composeConfigArgs,
  composeConfigFailure,
  firstErrorLine,
  parseComposeConfig,
} from './compose-config.js';

describe('parseComposeConfig', () => {
  it('lists services with published targets (long and short syntax) and expose, in order, without duplicates', () => {
    const out = JSON.stringify({
      name: 'x',
      services: {
        db: { image: 'postgres:17', expose: ['5432'] },
        web: {
          ports: [
            { mode: 'ingress', target: 8080, published: '8080', protocol: 'tcp' },
            '127.0.0.1:9000:80',
            '3000',
            { target: 8080 },
          ],
          expose: ['9229/tcp', '7000-7002'],
        },
        worker: { image: 'busybox' },
      },
    });
    expect(parseComposeConfig(out)).toEqual([
      { name: 'db', ports: [5432] },
      { name: 'web', ports: [8080, 80, 3000, 9229, 7000, 7001, 7002] },
      { name: 'worker', ports: [] },
    ]);
  });
  it('keeps at most 20 ports per service and drops names compose would not accept', () => {
    const out = JSON.stringify({ services: { web: { expose: ['1000-1100'] }, '-bad': {} } });
    expect(parseComposeConfig(out)).toEqual([
      { name: 'web', ports: Array.from({ length: 20 }, (_, i) => 1000 + i) },
    ]);
  });
  it('is null for output that is not a compose config', () => {
    expect(parseComposeConfig('not json')).toBeNull();
    expect(parseComposeConfig('[]')).toBeNull();
    expect(parseComposeConfig('{"services":[]}')).toBeNull();
  });
});

describe('firstErrorLine', () => {
  it('skips compose warnings and log prefixes', () => {
    expect(
      firstErrorLine(
        'WARN[0000] The "TAG" variable is not set. Defaulting to a blank string.\nyaml: line 2: did not find expected key\n',
      ),
    ).toBe('yaml: line 2: did not find expected key');
    expect(
      firstErrorLine(
        'time="2026-10-22T10:00:00Z" level=warning msg="x"\ntime="2026-10-22T10:00:00Z" level=error msg="env file /w/.env.local not found"\n',
      ),
    ).toBe('"env file /w/.env.local not found"');
    expect(firstErrorLine('', '')).toBeNull();
  });
});

describe('composeConfigFailure', () => {
  it('is the spec sentence, with one full stop', () => {
    expect(composeConfigFailure('compose.yaml', 'yaml: line 2: did not find expected key')).toBe(
      "Docker Compose couldn't read compose.yaml: yaml: line 2: did not find expected key.",
    );
    expect(composeConfigFailure('compose.yml', 'services must be a mapping.')).toBe(
      "Docker Compose couldn't read compose.yml: services must be a mapping.",
    );
  });
});

describe('composeConfigArgs', () => {
  it('reads the file from stdin in the main workspace, with interpolation', () => {
    const args = composeConfigArgs('emberline-main-abcdef12', '/workspaces/shop');
    expect(args).toEqual([
      'compose',
      '-p',
      'emberline-main-abcdef12',
      '--project-directory',
      '/workspaces/shop',
      '-f',
      '-',
      'config',
      '--format',
      'json',
    ]);
    expect(args).not.toContain('--no-interpolate');
  });
});
