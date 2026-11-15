import { describe, expect, it } from 'vitest';
import { laneCovers, laneOf, PROVIDER_RUNTIME, quotaPoolFor, Route, sameRoute } from './routing.js';

describe('routing helpers', () => {
  it('maps models to quota pools', () => {
    expect(quotaPoolFor('antigravity', 'argon')).toBe('argon');
    expect(quotaPoolFor('antigravity', 'gemini-pro')).toBe('gemini');
    expect(quotaPoolFor('antigravity', 'gemini-flash-lite')).toBe('gemini');
    expect(quotaPoolFor('claude', 'opus')).toBe('opus');
    expect(quotaPoolFor('codex', 'o3')).toBe('o3');
    expect(quotaPoolFor('claude', null)).toBe('*');
    expect(quotaPoolFor('claude', 'auto')).toBe('*');
  });

  it("a discovered model joins its family's pool, else the provider's", () => {
    expect(quotaPoolFor('antigravity', 'gemini-4-hydrogen-xhigh')).toBe(
      quotaPoolFor('antigravity', 'gemini-pro'),
    );
    expect(quotaPoolFor('claude', 'claude-opus-4-8')).toBe('opus');
    expect(quotaPoolFor('claude', 'claude-fable-5')).toBe('fable');
    expect(quotaPoolFor('claude', 'claude-mythos-5')).toBe('*');
    expect(quotaPoolFor('gemini', 'gemini-3.8-flash-high')).toBe('gemini-flash');
    expect(quotaPoolFor('gemini', 'gemini-3.8-flash-lite')).toBe('gemini-flash-lite');
    expect(quotaPoolFor('gemini', 'gemini-3.8-pro-high')).toBe('gemini-pro');
    expect(quotaPoolFor('gemini', 'gemini-pro')).toBe('gemini-pro');
    expect(quotaPoolFor('copilot', 'gpt-5.4')).toBe('*');
    expect(quotaPoolFor('copilot', 'gpt-4o')).toBe('gpt-4o');
    // Codex names the exact model a limit is for, so each model is its own pool.
    expect(quotaPoolFor('codex', 'gpt-5.4-codex')).toBe('gpt-5.4-codex');
  });

  it('a provider-wide window covers every pool of the same agent and credential only', () => {
    const wide = { agent: 'antigravity', credential: 'login', pool: '*' };
    expect(laneCovers(wide, laneOf({ agent: 'antigravity', model: 'argon', credential: 'login' }))).toBe(
      true,
    );
    expect(laneCovers(wide, laneOf({ agent: 'claude', model: 'opus', credential: 'login' }))).toBe(false);
    expect(laneCovers(wide, laneOf({ agent: 'antigravity', model: 'argon', credential: 'api_key' }))).toBe(
      false,
    );
    const opus = { agent: 'claude', credential: 'login', pool: 'opus' };
    expect(laneCovers(opus, laneOf({ agent: 'claude', model: 'sonnet', credential: 'login' }))).toBe(false);
    expect(laneCovers(opus, laneOf({ agent: 'claude', model: 'opus', credential: 'login' }))).toBe(true);
  });

  it('knows which credentials and resume mode each provider supports', () => {
    expect(PROVIDER_RUNTIME.antigravity).toEqual({
      credentials: ['login', 'credits'],
      resumeMode: 'continue_latest',
    });
    expect(PROVIDER_RUNTIME.aider.credentials).toEqual(['api_key']);
    expect(PROVIDER_RUNTIME.claude.resumeMode).toBe('session');
    expect(PROVIDER_RUNTIME.gemini.resumeMode).toBe('fresh');
  });

  it('parses routes with a login default and compares them', () => {
    const a = Route.parse({ agent: 'claude', model: 'opus' });
    expect(a.credential).toBe('login');
    expect(sameRoute(a, { agent: 'claude', model: 'opus', credential: 'login' })).toBe(true);
    expect(sameRoute(a, { agent: 'claude', model: 'opus', credential: 'api_key' })).toBe(false);
  });
});
