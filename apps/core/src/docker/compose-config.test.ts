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
  it('lists a normal range port by port, and skips ports and ranges above 65535', () => {
    const out = JSON.stringify({
      services: {
        web: {
          expose: ['8000-8003', '65536-99999', '70000-99999/udp', '65530-70000'],
          ports: [{ target: 99999 }, '99999'],
        },
      },
    });
    expect(parseComposeConfig(out)).toEqual([
      { name: 'web', ports: [8000, 8001, 8002, 8003, 65530, 65531, 65532, 65533, 65534, 65535] },
    ]);
  });
  it('never walks a range or examines more entries than its budget: 1 MB of out-of-range ranges parses at once', () => {
    // The reviewer's case: 100 services sharing 440 distinct out-of-range ranges (compose prints them as is).
    const ranges = Array.from({ length: 440 }, (_, i) => `65536-${99999 - i}`);
    const services = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}`, { expose: ranges }]));
    const started = performance.now();
    expect(parseComposeConfig(JSON.stringify({ services }))).toEqual(
      Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, ports: [] })),
    );
    expect(performance.now() - started).toBeLessThan(500);
  });
  it('stops examining entries after the total budget, and services after theirs', () => {
    const junk = Array.from({ length: 5000 }, () => 'x');
    const out = JSON.stringify({ services: { a: { expose: [...junk, '8080'] }, b: { expose: ['9090'] } } });
    expect(parseComposeConfig(out)).toEqual([
      { name: 'a', ports: [] },
      { name: 'b', ports: [] },
    ]);
    const many = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`-bad${i}`, {}]));
    expect(parseComposeConfig(JSON.stringify({ services: { ...many, web: { expose: ['80'] } } }))).toEqual(
      [],
    );
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
