import { describe, expect, it } from 'vitest';
import { inspectComposeStack } from './compose-isolation.js';

const PROJECT = 'emberline-1234abcd-preview';
const config = (doc: object) => JSON.stringify({ name: PROJECT, ...doc });

describe('inspectComposeStack', () => {
  it('a stack whose names all come from the project passes and lists its services', () => {
    const stdout = config({
      services: { web: { image: 'nginx' }, db: { image: 'postgres' }, 'bad name': {} },
      volumes: { data: { name: `${PROJECT}_data` } },
      networks: { default: { name: `${PROJECT}_default` } },
    });
    expect(inspectComposeStack(stdout, PROJECT, 'compose.yaml')).toEqual({
      ok: true,
      services: ['web', 'db'],
    });
  });

  it('another project prefix is a fixed name too (a name copied from another worktree)', () => {
    const stdout = config({
      services: { web: {} },
      volumes: { data: { name: 'emberline-ffffffff-preview_data' } },
    });
    const result = inspectComposeStack(stdout, PROJECT, 'compose.yaml');
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain(
      'volume "data" has the fixed name "emberline-ffffffff-preview_data"',
    );
  });

  it('an external volume is refused even without a name of its own', () => {
    const result = inspectComposeStack(
      config({ services: { web: {} }, volumes: { shared: { external: true } } }),
      PROJECT,
      'docker-compose.yml',
    );
    expect(!result.ok && result.error).toContain('docker-compose.yml fixes names');
    expect(!result.ok && result.error).toContain('volume "shared" is external ("shared")');
  });

  it('lists at most five fixed names, then counts the rest', () => {
    const services = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`s${i}`, { container_name: `fixed-${i}` }]),
    );
    const result = inspectComposeStack(config({ services }), PROJECT, 'compose.yaml');
    expect(!result.ok && result.error).toContain('service "s4" sets container_name "fixed-4"; and 2 more.');
    expect(!result.ok && result.error).not.toContain('"s5"');
  });

  it('output that is not a resolved config is refused, never read as an empty stack', () => {
    expect(inspectComposeStack('web\ndb\n', PROJECT, 'compose.yaml')).toEqual({
      ok: false,
      error: 'docker compose config did not print the configuration of compose.yaml',
    });
    expect(inspectComposeStack('{"services":[]}', PROJECT, 'compose.yaml')).toEqual({
      ok: false,
      error: 'docker compose config printed no services for compose.yaml',
    });
  });

  it('an empty container_name sets nothing', () => {
    const result = inspectComposeStack(
      config({ services: { web: { container_name: '' } } }),
      PROJECT,
      'compose.yaml',
    );
    expect(result).toEqual({ ok: true, services: ['web'] });
  });
});
