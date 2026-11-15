import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentModelId,
  BUILTIN_MODELS,
  KNOWN_AT_RELEASE,
  PROVIDER_REGISTRY,
  coerceModelForProvider,
  getModelCatalog,
  getModelsForProvider,
  isModelValidForProvider,
  modelLabel,
  rankFromName,
  resolveCliModel,
  setModelCatalog,
  type ProviderModelInfo,
} from './runs.js';

function entry(id: string, rank: ProviderModelInfo['rank'], label = id): ProviderModelInfo {
  return {
    id,
    label,
    shortLabel: id,
    rank,
    tier: rank >= 4 ? 'high' : rank === 3 ? 'medium' : 'low',
    badge: '',
    capabilities: ['code'],
    description: '',
    source: 'cli',
  };
}

afterEach(() => setModelCatalog(null));

describe('AgentModelId', () => {
  it('accepts auto and CLI-reported ids', () => {
    expect(AgentModelId.safeParse('auto').success).toBe(true);
    expect(AgentModelId.safeParse('gemini-4-hydrogen-xhigh').success).toBe(true);
  });
  it('rejects ids that are unsafe as one shell word or too long', () => {
    for (const bad of ['a b', '$(x)', '', 'a'.repeat(129)]) {
      expect(AgentModelId.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('runtime catalog', () => {
  it('adds catalog entries to the built-ins and validates them', () => {
    setModelCatalog({
      antigravity: [entry('gemini-4-hydrogen-xhigh', 5, 'Gemini 4 Hydrogen (XHigh)')],
    } as never);
    const ids = getModelsForProvider('antigravity').map((m) => m.id);
    expect(ids).toContain('gemini-4-hydrogen-xhigh');
    for (const b of BUILTIN_MODELS.antigravity) expect(ids).toContain(b.id);
    expect(isModelValidForProvider('antigravity', 'gemini-4-hydrogen-xhigh')).toBe(true);
    expect(isModelValidForProvider('claude', 'gemini-4-hydrogen-xhigh')).toBe(false);
    const coerced = coerceModelForProvider('claude', 'gemini-4-hydrogen-xhigh');
    expect(BUILTIN_MODELS.claude.find((m) => m.id === coerced)?.rank).toBe(5);
  });
  it('lets a catalog entry win on label and cliId without duplicating the id', () => {
    setModelCatalog({ claude: [{ ...entry('opus', 4, 'Opus 5'), cliId: 'claude-opus-5' }] } as never);
    const opus = getModelsForProvider('claude').filter((m) => m.id === 'opus');
    expect(opus).toHaveLength(1);
    expect(opus[0]!.label).toBe('Opus 5');
    expect(opus[0]!.cliId).toBe('claude-opus-5');
    expect(modelLabel('claude', 'opus')).toBe('Opus 5');
  });
  it('restores built-ins only on null', () => {
    setModelCatalog({ antigravity: [entry('x-model', 3)] } as never);
    setModelCatalog(null);
    expect(getModelsForProvider('antigravity')).toEqual(BUILTIN_MODELS.antigravity);
    expect(getModelCatalog().antigravity).toEqual([]);
  });
  it('keeps the registry models pointing at the built-ins, marked builtin', () => {
    expect(PROVIDER_REGISTRY.claude.models).toBe(BUILTIN_MODELS.claude);
    expect(BUILTIN_MODELS.claude.every((m) => m.source === 'builtin')).toBe(true);
  });
  it('lists what each CLI knew at release', () => {
    expect(KNOWN_AT_RELEASE.antigravity).toHaveLength(15);
    expect(KNOWN_AT_RELEASE.antigravity.some((id) => id.startsWith('gemini-4-hydrogen'))).toBe(false);
    expect(KNOWN_AT_RELEASE.antigravity.some((id) => id.startsWith('gemini-4-carbon'))).toBe(false);
    expect(KNOWN_AT_RELEASE.claude).toContain('claude-opus-5');
  });
});

describe('modelLabel', () => {
  it('falls back to the id', () => {
    expect(modelLabel('claude', 'fable')).toBe('Claude Fable');
    expect(modelLabel('claude', 'claude-future-9')).toBe('claude-future-9');
  });
});

describe('rankFromName', () => {
  it('derives rank and tier from the effort suffix', () => {
    expect(rankFromName('gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)')).toEqual({
      rank: 5,
      tier: 'high',
    });
    expect(rankFromName('gemini-4-hydrogen-high', 'x')).toEqual({ rank: 4, tier: 'high' });
    expect(rankFromName('gemini-4-hydrogen-medium', 'x')).toEqual({ rank: 3, tier: 'medium' });
    expect(rankFromName('gemini-3.8-flash-low', 'x')).toEqual({ rank: 2, tier: 'low' });
    expect(rankFromName('foo', 'Foo')).toEqual({ rank: 3, tier: 'medium' });
  });
});

describe('resolveCliModel', () => {
  it('maps a built-in family to the highest-ranked catalog entry', () => {
    setModelCatalog({
      antigravity: [
        entry('gemini-4-argon-low', 2),
        entry('gemini-4-argon-medium', 3),
        entry('gemini-4-argon-high', 4),
      ],
    } as never);
    expect(resolveCliModel('antigravity', 'argon')).toBe('gemini-4-argon-high');
  });
  it('prefers the bare family id on equal rank, then the shorter tail', () => {
    setModelCatalog({
      antigravity: [entry('gemini-4-argon-high', 4), entry('gemini-pro-orchestrator-argon', 4)],
    } as never);
    expect(resolveCliModel('antigravity', 'argon')).toBe('gemini-pro-orchestrator-argon');
  });
  it('returns null with no family entry', () => {
    expect(resolveCliModel('antigravity', 'argon')).toBeNull();
  });
  it('passes Claude aliases and catalog ids through, honouring cliId', () => {
    expect(resolveCliModel('claude', 'fable')).toBe('fable');
    setModelCatalog({ claude: [{ ...entry('claude-opus-5', 4), cliId: 'opus5' }] } as never);
    expect(resolveCliModel('claude', 'claude-opus-5')).toBe('opus5');
  });
});
