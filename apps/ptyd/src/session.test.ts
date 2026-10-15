import { afterEach, describe, expect, it } from 'vitest';
import { pickBaseEnv } from './session.js';

const KEYS = ['JAVA_HOME', 'PIPX_HOME', 'EMBERLINE_TEST_SECRET'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('pickBaseEnv', () => {
  it('passes the runner tool locations to sessions but nothing else from ptyd', () => {
    process.env.JAVA_HOME = '/opt/ai-tools/sdk/jdk';
    process.env.PIPX_HOME = '/opt/ai-tools/pipx';
    process.env.EMBERLINE_TEST_SECRET = 'do-not-leak';
    const env = pickBaseEnv();
    expect(env.JAVA_HOME).toBe('/opt/ai-tools/sdk/jdk');
    expect(env.PIPX_HOME).toBe('/opt/ai-tools/pipx');
    expect(env).not.toHaveProperty('EMBERLINE_TEST_SECRET');
  });
});
