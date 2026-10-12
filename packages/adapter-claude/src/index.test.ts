import { describe, expect, it } from 'vitest';
import { buildHookSettings, WATCHED_HOOKS } from './index.js';

describe('buildHookSettings', () => {
  it('wires every watched hook to the hook command', () => {
    const settings = buildHookSettings('/usr/local/bin/emberline-hook');
    expect(Object.keys(settings.hooks).sort()).toEqual([...WATCHED_HOOKS].sort());
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe('/usr/local/bin/emberline-hook Stop');
  });

  it('adds a catch-all matcher only for tool events', () => {
    const settings = buildHookSettings('h');
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('');
    expect(settings.hooks.Stop?.[0]).not.toHaveProperty('matcher');
  });
});
