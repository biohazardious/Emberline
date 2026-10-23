import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { startupWarnings } from './startup-warnings.js';

const warningsFor = (env: NodeJS.ProcessEnv) => startupWarnings(env, loadConfig(env));

describe('startupWarnings', () => {
  it('says nothing for a plain set-up', () => {
    expect(warningsFor({})).toEqual([]);
  });

  it('names allowed hosts that are not host names', () => {
    expect(warningsFor({ EMBERLINE_ALLOWED_HOSTS: 'good.example, not a host!' })).toEqual([
      {
        data: { ignored: ['not a host!'] },
        message: 'EMBERLINE_ALLOWED_HOSTS: ignoring entries that are not host names',
      },
    ]);
  });

  it('names container networks that are not CIDR ranges, keeping the valid ones', () => {
    const env = { EMBERLINE_CONTAINER_NETWORKS: '100.64.0.0/10, 100.64.0.0/99, nope' };
    expect(loadConfig(env).containerNetworks).toEqual(['100.64.0.0/10']);
    expect(startupWarnings(env, loadConfig(env))).toEqual([
      {
        data: { ignored: ['100.64.0.0/99', 'nope'] },
        message:
          'EMBERLINE_CONTAINER_NETWORKS: ignoring entries that are not CIDR ranges (like 100.64.0.0/10)',
      },
    ]);
  });

  it('warns about a /0 container network, which takes in every address', () => {
    const [warning, ...rest] = warningsFor({ EMBERLINE_CONTAINER_NETWORKS: '0.0.0.0/0' });
    expect(rest).toEqual([]);
    expect(warning?.data).toEqual({ ranges: ['0.0.0.0/0'] });
    expect(warning?.message).toContain('a /0 range takes in every address');
  });

  it('names a preview port variable that is not a range', () => {
    expect(warningsFor({ EMBERLINE_PREVIEW_PORTS_RUNNER: 'abc' })).toEqual([
      {
        data: { variables: ['EMBERLINE_PREVIEW_PORTS_RUNNER'] },
        message: 'preview ports: not a port range (like 4300-4324); using the default',
      },
    ]);
  });

  it('warns when the runner and docker preview ranges overlap', () => {
    const [warning, ...rest] = warningsFor({
      EMBERLINE_PREVIEW_PORTS_RUNNER: '4300-4310',
      EMBERLINE_PREVIEW_PORTS_DOCKER: '4310-4320',
    });
    expect(rest).toEqual([]);
    expect(warning?.message).toContain(
      'EMBERLINE_PREVIEW_PORTS_RUNNER and EMBERLINE_PREVIEW_PORTS_DOCKER overlap',
    );
    expect(warning?.data).toEqual({
      runner: { first: 4300, last: 4310 },
      docker: { first: 4310, last: 4320 },
    });
  });

  it('warns when more than 100 preview ports are configured', () => {
    const [warning, ...rest] = warningsFor({
      EMBERLINE_PREVIEW_PORTS_RUNNER: '4300-4400',
      EMBERLINE_PREVIEW_PORTS_DOCKER: '4500-4510',
    });
    expect(rest).toEqual([]);
    expect(warning?.message).toContain('More than 100 preview ports are configured');
  });

  it('warns when listing the ports for the preview host makes the frame policy too long', () => {
    const host = `https://${'a'.repeat(50)}.example.com`;
    const env = {
      EMBERLINE_PREVIEW_HOST: host,
      EMBERLINE_PREVIEW_PORTS_RUNNER: '4300-4350',
      EMBERLINE_PREVIEW_PORTS_DOCKER: '4400-4440',
    };
    const [warning, ...rest] = warningsFor(env);
    expect(rest).toEqual([]);
    expect(warning?.message).toContain('would make the frame policy longer than 3 KB');
    expect(warning?.data).toMatchObject({ previewHost: host });
    expect(warningsFor({ ...env, EMBERLINE_PREVIEW_HOST: 'http://p.example.com' })).toEqual([]);
  });
});
