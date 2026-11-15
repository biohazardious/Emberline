import { setModelCatalog } from '@emberline/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { currentRoute, parseRouteTag, runModel, runRoutes } from './route.js';

afterEach(() => setModelCatalog(null));

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
    expect(parseRouteTag('x [Preferred Agent: claude · Model: opus]')).toEqual({
      agent: 'claude',
      model: 'opus',
    });
    expect(parseRouteTag('no tag')).toBeUndefined();
  });

  it("keeps a hand-added model id's case and lowercases only the agent", () => {
    expect(parseRouteTag('[Preferred Agent: Copilot · Model: Claude-Opus-4.5-Preview]')).toEqual({
      agent: 'copilot',
      model: 'Claude-Opus-4.5-Preview',
    });
  });

  it("folds a hand-typed tag's case to the one id the agent knows that way", () => {
    expect(parseRouteTag('[Preferred Agent: claude · Model: Opus]')).toEqual({
      agent: 'claude',
      model: 'opus',
    });
    // An id no CLI or built-in knows is left as typed, for the run's coercion.
    expect(parseRouteTag('[Preferred Agent: claude · Model: Opus-Max]')?.model).toBe('Opus-Max');
  });

  it('keeps a mixed-case id the agent has exactly, even when another id differs only in case', () => {
    const manual = (id: string) => ({
      id,
      label: id,
      shortLabel: id,
      rank: 4,
      tier: 'high',
      badge: '',
      capabilities: ['code'],
      description: '',
      source: 'manual',
    });
    setModelCatalog({ copilot: [manual('Claude-Opus-4.5-Preview')] } as never);
    expect(parseRouteTag('[Preferred Agent: copilot · Model: Claude-Opus-4.5-Preview]')?.model).toBe(
      'Claude-Opus-4.5-Preview',
    );
    expect(parseRouteTag('[Preferred Agent: copilot · Model: claude-opus-4.5-preview]')?.model).toBe(
      'Claude-Opus-4.5-Preview',
    );
    setModelCatalog({
      copilot: [manual('Claude-Opus-4.5-Preview'), manual('claude-opus-4.5-preview')],
    } as never);
    expect(parseRouteTag('[Preferred Agent: copilot · Model: Claude-Opus-4.5-Preview]')?.model).toBe(
      'Claude-Opus-4.5-Preview',
    );
    // Two ids match ignoring case, so neither is guessed.
    expect(parseRouteTag('[Preferred Agent: copilot · Model: CLAUDE-OPUS-4.5-PREVIEW]')?.model).toBe(
      'CLAUDE-OPUS-4.5-PREVIEW',
    );
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
