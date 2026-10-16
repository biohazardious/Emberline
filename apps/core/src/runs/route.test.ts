import { describe, expect, it } from 'vitest';
import { currentRoute, parseRouteTag, runModel, runRoutes } from './route.js';

const legacy = {
  agent: 'antigravity',
  model: null,
  credential: 'login',
  routes: [],
  routeIndex: 0,
  prompt: 'MPG-28 Accessibility\n\n[Preferred Agent: antigravity · Model: argon]',
} as never;

describe('run routes', () => {
  it('parses the legacy route tag', () => {
    expect(parseRouteTag('x [Preferred Agent: claude · Model: opus]')).toEqual({ agent: 'claude', model: 'opus' });
    expect(parseRouteTag('no tag')).toBeUndefined();
  });

  it('reads a pre-0.2.0 row: model from the tag, a one-step chain', () => {
    expect(runModel(legacy)).toBe('argon');
    expect(runRoutes(legacy)).toEqual([{ agent: 'antigravity', model: 'argon', credential: 'login' }]);
    expect(currentRoute(legacy)).toEqual({ agent: 'antigravity', model: 'argon', credential: 'login' });
  });

  it('uses the stored chain and index on new rows', () => {
    const row = {
      ...(legacy as object),
      model: 'opus',
      agent: 'claude',
      routes: [
        { agent: 'antigravity', model: 'argon', credential: 'login' },
        { agent: 'claude', model: 'opus', credential: 'login' },
      ],
      routeIndex: 1,
    } as never;
    expect(currentRoute(row)).toEqual({ agent: 'claude', model: 'opus', credential: 'login' });
  });
});
