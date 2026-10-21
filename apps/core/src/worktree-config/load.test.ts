import { describe, expect, it } from 'vitest';
import { parseWorktreeYml } from './load.js';

const errorsOf = (text: string): string[] => {
  const parsed = parseWorktreeYml(text);
  if (parsed.ok) throw new Error('expected the file to be invalid');
  return parsed.errors;
};

describe('parseWorktreeYml unrecognized keys name the allowed ones', () => {
  it('at the root', () => {
    expect(errorsOf('version: 1\nfoo: true\n')).toEqual([
      '(file): Unrecognized key: "foo" (allowed: version, copy, setup, teardown, services, checks)',
    ]);
  });

  it('in checks', () => {
    expect(errorsOf('version: 1\nchecks:\n  container: npm run test:container\n')).toEqual([
      'checks: Unrecognized key: "container" (allowed: build, lint, test)',
    ]);
  });

  it('with several unknown keys, once', () => {
    expect(errorsOf('version: 1\nchecks:\n  container: a\n  e2e: b\n')).toEqual([
      'checks: Unrecognized keys: "container", "e2e" (allowed: build, lint, test)',
    ]);
  });

  it('in a service', () => {
    expect(
      errorsOf('version: 1\nservices:\n  - name: api\n    command: npm start\n    port: 3000\n'),
    ).toEqual(['services.0: Unrecognized key: "port" (allowed: name, command, compose, preview)']);
  });

  it("in a service's compose reference", () => {
    expect(
      errorsOf(
        'version: 2\nservices:\n  - name: web\n    compose:\n      service: web\n      port: 80\n      image: nginx\n',
      ),
    ).toEqual(['services.0.compose: Unrecognized key: "image" (allowed: file, service, port)']);
  });

  it('in a copy entry written as an object', () => {
    expect(errorsOf('version: 1\ncopy:\n  - path: .env\n    owner: me\n')).toEqual([
      'copy.0: Unrecognized key: "owner" (allowed: path, mode)',
    ]);
  });

  it('leaves other errors as they were', () => {
    const errors = errorsOf('version: 3\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^version: /);
    expect(errors[0]).not.toContain('allowed');
  });
});
