import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builderPruneArgs,
  RECLAIM_IMAGE,
  isEmberlineComposeProject,
  parseComposeLs,
  reclaimArgs,
  answeredHttp,
  COMPOSE_LOGS_MAX_CHARS,
  COMPOSE_OVERRIDE_ENV,
  composeDownArgs,
  composeLogsArgs,
  composeOutputTail,
  composeOverrideYaml,
  composePsArgs,
  composePsGone,
  composeServiceState,
  composeServicesArgs,
  composeShell,
  composeUpArgs,
  engineHostName,
  parseComposePs,
  parseComposeServices,
} from './compose.js';
import { RUNNER_BIN } from '../command-exec.js';

describe('compose command lines', () => {
  it('up: the project from the run, the project file, the override from stdin, then the service', () => {
    expect(composeUpArgs('emberline-abcd1234', 'compose.yaml', 'web')).toEqual([
      'compose',
      '-p',
      'emberline-abcd1234',
      '-f',
      'compose.yaml',
      '-f',
      '-',
      'up',
      '-d',
      '--build',
      '--',
      'web',
    ]);
  });
  it('config --services reads only the project file, with every profile', () => {
    expect(composeServicesArgs('emberline-abcd1234', 'deploy/compose.yml')).toEqual([
      'compose',
      '-p',
      'emberline-abcd1234',
      '-f',
      'deploy/compose.yml',
      '--profile',
      '*',
      'config',
      '--services',
    ]);
  });
  it('ps, logs and down go by project name only (they work when the file changed or is gone)', () => {
    expect(composePsArgs('emberline-abcd1234')).toEqual([
      'compose',
      '-p',
      'emberline-abcd1234',
      'ps',
      '--all',
      '--format',
      'json',
    ]);
    expect(composeLogsArgs('emberline-abcd1234', 'web')).toEqual([
      'compose',
      '-p',
      'emberline-abcd1234',
      'logs',
      '--no-color',
      '--tail',
      '200',
      '--',
      'web',
    ]);
    expect(composeDownArgs('emberline-abcd1234')).toEqual([
      'compose',
      '-p',
      'emberline-abcd1234',
      'down',
      '--remove-orphans',
    ]);
    expect(composeDownArgs('emberline-abcd1234', { volumes: true })).toEqual([
      'compose',
      '-p',
      'emberline-abcd1234',
      'down',
      '-v',
      '--remove-orphans',
    ]);
    // Cleanup also removes the images the project built (not pulled ones with their own tag).
    expect(composeDownArgs('emberline-abcd1234', { volumes: true, images: true })).toEqual([
      'compose',
      '-p',
      'emberline-abcd1234',
      'down',
      '-v',
      '--rmi',
      'local',
      '--remove-orphans',
    ]);
  });
  it('the override reaches compose on stdin from a variable, never as a file or an argument', () => {
    const { file, args } = composeShell(['compose', 'up']);
    expect(file).toBe(RUNNER_BIN.sh);
    expect(args.slice(2)).toEqual(['sh', 'compose', 'up']);
    expect(args[1]).toContain(`printf '%s' "$${COMPOSE_OVERRIDE_ENV}" | exec ${RUNNER_BIN.docker} "$@"`);
  });

  describe("the runner's Docker CLI directories", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'compose-shell-'));
      // The script as the runner runs it, with a recorder in the Docker CLI's place.
      writeFileSync(
        path.join(dir, 'docker'),
        `#!/bin/sh\n{ echo "args=$*"; echo "config=$DOCKER_CONFIG"; echo "buildx=$BUILDX_CONFIG"; echo "stdin=$(cat)"; } > ${dir}/seen\nexit 7\n`,
      );
      chmodSync(path.join(dir, 'docker'), 0o755);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const runShell = (buildx: string) => {
      const { args } = composeShell(['compose', 'up']);
      const script = args[1]!.replaceAll(RUNNER_BIN.docker, path.join(dir, 'docker'));
      const run = spawnSync(RUNNER_BIN.sh, ['-c', script, ...args.slice(2)], {
        env: {
          [COMPOSE_OVERRIDE_ENV]: 'services: {}',
          DOCKER_CONFIG: '/image/config',
          BUILDX_CONFIG: buildx,
        },
      });
      const seen = readFileSync(path.join(dir, 'seen'), 'utf8');
      const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(seen)?.[1] ?? '';
      return { status: run.status, seen, value };
    };

    it("the image's directories, the override on stdin, and docker's exit code", () => {
      mkdirSync(path.join(dir, 'buildx'));
      const { status, seen, value } = runShell(path.join(dir, 'buildx'));
      expect(status).toBe(7);
      expect(seen).toContain('args=compose up');
      expect(seen).toContain('stdin=services: {}');
      expect(value('config')).toBe('/image/config');
      expect(value('buildx')).toBe(path.join(dir, 'buildx'));
    });
  });
});

describe('composeOverrideYaml', () => {
  it('publishes only <hostPort>:<port> for the preview service and no host port for the others', () => {
    const yaml = composeOverrideYaml({
      service: 'web',
      port: 80,
      hostPort: 4331,
      services: ['db', 'web', 'cache'],
    });
    expect(yaml).toBe(
      [
        'services:',
        '  "db":',
        '    ports: !reset []',
        '    container_name: !reset null',
        '  "web":',
        '    ports: !override ["4331:80"]',
        '    container_name: !reset null',
        '  "cache":',
        '    ports: !reset []',
        '    container_name: !reset null',
        '',
      ].join('\n'),
    );
  });
  it('always names the preview service, even if the list missed it', () => {
    expect(composeOverrideYaml({ service: 'web', port: 8080, hostPort: 4325, services: [] })).toContain(
      '  "web":\n    ports: !override ["4325:8080"]',
    );
  });
});

describe('parsing compose output', () => {
  it('service names, one per line, junk dropped', () => {
    expect(parseComposeServices('db\nweb\n\nWARN[0000] something\n')).toEqual(['db', 'web']);
  });
  it('ps: NDJSON (compose v5) and a JSON array (older compose)', () => {
    const line = (o: object) => JSON.stringify(o);
    const ndjson = [
      line({
        Service: 'web',
        State: 'running',
        Health: '',
        ExitCode: 0,
        Publishers: [{ PublishedPort: 4330, TargetPort: 80 }],
      }),
      line({ Service: 'db', State: 'exited', Health: '', ExitCode: 1 }),
    ].join('\n');
    expect(parseComposePs(ndjson)).toEqual([
      { service: 'web', state: 'running', health: '', exitCode: 0 },
      { service: 'db', state: 'exited', health: '', exitCode: 1 },
    ]);
    expect(parseComposePs(`[${line({ Service: 'web', State: 'Running', Health: 'Healthy' })}]`)).toEqual([
      { service: 'web', state: 'running', health: 'healthy', exitCode: null },
    ]);
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('not json\n{"Service":"web","State":"created"}\n{"no":"service"}')).toEqual([
      { service: 'web', state: 'created', health: '', exitCode: null },
    ]);
  });
  it('ps --all says gone only for no containers; output that is not compose JSON never means gone', () => {
    expect(composePsGone('')).toBe(true);
    expect(composePsGone('  \n')).toBe(true);
    expect(composePsGone('[]')).toBe(true); // older compose: a JSON array
    expect(composePsGone('{"Service":"web","State":"exited"}')).toBe(false);
    expect(composePsGone('WARN[0000] the attribute `version` is obsolete')).toBeNull();
    expect(composePsGone('{"no":"service"}')).toBeNull();
  });
  it('service state: running, starting, stopped, missing', () => {
    const c = (service: string, state: string, health = '') => ({ service, state, health, exitCode: null });
    expect(composeServiceState([c('web', 'running')], 'web')).toBe('running');
    expect(composeServiceState([c('web', 'running', 'healthy')], 'web')).toBe('running');
    expect(composeServiceState([c('web', 'running', 'starting')], 'web')).toBe('starting');
    expect(composeServiceState([c('web', 'restarting')], 'web')).toBe('starting');
    expect(composeServiceState([c('web', 'created')], 'web')).toBe('starting');
    expect(composeServiceState([c('web', 'exited')], 'web')).toBe('stopped');
    expect(composeServiceState([c('web', 'dead')], 'web')).toBe('stopped');
    expect(composeServiceState([c('db', 'running')], 'web')).toBe('missing');
  });
  it('the output tail has no colours or control characters and at most 2000 chars', () => {
    expect(composeOutputTail('\u001b[31merror\u001b[0m: boom\r\nnext\u0007\n\n')).toBe('error: boom\nnext');
    const long = `${'x'.repeat(5000)}END`;
    const tail = composeOutputTail(long);
    expect(tail.length).toBeLessThanOrEqual(COMPOSE_LOGS_MAX_CHARS);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('END')).toBe(true);
  });
  it('an HTTP status from curl means the server answers; 000 means it did not', () => {
    expect(answeredHttp('200')).toBe(true);
    expect(answeredHttp('404\n')).toBe(true);
    expect(answeredHttp('502')).toBe(true);
    expect(answeredHttp('000')).toBe(false);
    expect(answeredHttp('')).toBe(false);
  });
  it('the engine host name comes from EMBERLINE_DOCKER_HOST', () => {
    expect(engineHostName('tcp://docker:2376')).toBe('docker');
    expect(engineHostName('tcp://10.0.0.5:2376')).toBe('10.0.0.5');
    expect(engineHostName('garbage')).toBe('docker');
  });
});

describe('cleanup builders', () => {
  it('only the names Emberline makes count as its compose projects', () => {
    for (const name of [
      'emberline-deadbeef',
      'emberline-0a1b2c3d-preview',
      'emberline-main-12345678',
      'emberline-main-12345678-preview',
    ]) {
      expect(isEmberlineComposeProject(name), name).toBe(true);
    }
    for (const name of [
      'emberline',
      'emberline-verify-docker',
      'emberline-e2e',
      'emberline-DEADBEEF',
      'emberline-deadbeef-extra',
      'emberline-deadbeef0',
      'shop',
      'x-emberline-deadbeef',
      'emberline-main-preview',
      'emberline-main-1234567-preview',
      'emberline-main-12345678-preview-x',
      'emberline-main-12345678-previews',
      'emberline-deadbeef-preview-preview',
      'emberline-main-main-12345678',
    ]) {
      expect(isEmberlineComposeProject(name), name).toBe(false);
    }
  });

  it('reads project names from `compose ls --format json`', () => {
    expect(
      parseComposeLs(
        '[{"Name":"emberline-deadbeef","Status":"exited(1)","ConfigFiles":"/w/compose.yaml"},{"Name":3},{}]\n',
      ),
    ).toEqual(['emberline-deadbeef']);
    expect(parseComposeLs('')).toEqual([]);
    expect(parseComposeLs('not json')).toEqual([]);
  });

  it('the reclaim container mounts only an absolute path without commas', () => {
    expect(reclaimArgs('/workspaces/.worktrees/shop/deadbeef')).toContain(
      'type=bind,source=/workspaces/.worktrees/shop/deadbeef,target=/w',
    );
    expect(() => reclaimArgs('/workspaces/a,b')).toThrow();
    expect(() => reclaimArgs('relative')).toThrow();
  });
});

describe('cleanup pins', () => {
  it('the reclaim image is pinned by digest', () => {
    expect(RECLAIM_IMAGE).toMatch(/^busybox:1\.37\.0@sha256:[0-9a-f]{64}$/);
  });
  it('the daily prune also drops build cache older than 72 h', () => {
    expect(builderPruneArgs()).toEqual(['builder', 'prune', '-f', '--filter', 'until=72h']);
  });
});
