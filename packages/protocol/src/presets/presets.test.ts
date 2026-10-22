import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  PROJECT_TYPES,
  STACK_DIMENSIONS,
  VERSION_POLICIES,
  getPreset,
  isAutoPreset,
  optionsForType,
  presetsForType,
  StackChoice,
  ProjectChoices,
  VISION_MIN_LENGTH,
  visionRequired,
} from './index.js';
import { ProjectAppType, CreateProjectBody } from '../api/projects.js';

describe('preset registry integrity', () => {
  it('has one project type per ProjectAppType id, ids unique, incl. static_site', () => {
    const ids = PROJECT_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ProjectAppType.options].sort());
    expect(ids).toContain('static_site');
    for (const t of PROJECT_TYPES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });

  it('declares the required dimensions', () => {
    const ids = STACK_DIMENSIONS.map((d) => d.id);
    expect(ids).toEqual([
      'frontend',
      'backend',
      'database',
      'auth',
      'deploy',
      'language',
      'styling',
      'testing',
    ]);
    expect(STACK_DIMENSIONS.filter((d) => d.advanced).map((d) => d.id)).toEqual([
      'language',
      'styling',
      'testing',
    ]);
  });

  it('option ids are globally unique and apply to known types', () => {
    const all = STACK_DIMENSIONS.flatMap((d) => d.options.map((o) => o.id));
    expect(new Set(all).size).toBe(all.length);
    const typeIds = new Set<string>(PROJECT_TYPES.map((t) => t.id));
    for (const d of STACK_DIMENSIONS) {
      for (const o of d.options) {
        expect(o.types.length).toBeGreaterThan(0);
        for (const t of o.types) expect(typeIds.has(t)).toBe(true);
        expect(['none', 'agent']).not.toContain(o.id);
      }
    }
  });

  it('preset ids are unique and every type has at least one preset', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PROJECT_TYPES) {
      expect(PRESETS.filter((p) => p.type === t.id).length).toBeGreaterThan(0);
    }
  });

  it('every preset choice references an option valid for the preset type', () => {
    const problems: string[] = [];
    for (const p of PRESETS) {
      for (const [dim, choice] of Object.entries(p.choices)) {
        const dimension = STACK_DIMENSIONS.find((d) => d.id === dim);
        if (!dimension) {
          problems.push(`${p.id}: unknown dimension ${dim}`);
          continue;
        }
        if (choice === 'none' || choice === 'agent') continue;
        const opt = dimension.options.find((o) => o.id === choice);
        if (!opt) problems.push(`${p.id}.${dim} -> ${String(choice)} does not exist`);
        else if (!opt.types.includes(p.type))
          problems.push(`${p.id}.${dim} -> ${String(choice)} not valid for ${p.type}`);
      }
      expect(ProjectChoices.safeParse(p.choices).success).toBe(true);
    }
    expect(problems).toEqual([]);
  });

  it('every type offers auth and deploy options, including app stores for mobile', () => {
    for (const t of PROJECT_TYPES) {
      const auth = optionsForType('auth', t.id);
      const deploy = optionsForType('deploy', t.id);
      expect(deploy.length, `${t.id} deploy`).toBeGreaterThan(0);
      if (t.id !== 'embedded_iot' && t.id !== 'library')
        expect(auth.length, `${t.id} auth`).toBeGreaterThan(0);
    }
    expect(optionsForType('deploy', 'mobile_desktop').some((o) => o.id === 'app-stores')).toBe(true);
  });

  it('static_site presets: plain starter and the three agent-built ones', () => {
    const labels = PRESETS.filter((p) => p.type === 'static_site').map((p) => p.label);
    expect(labels).toEqual([
      'Auto — let the agent choose',
      'Plain HTML/CSS/JS',
      'Vite (vanilla)',
      'Astro',
      'Eleventy',
    ]);
    const plain = getPreset('static-plain')!;
    expect(plain.starter).toBe('static-plain');
    expect(plain.choices.frontend).toBe('plain-html');
    const opt = STACK_DIMENSIONS.find((d) => d.id === 'frontend')!.options.find(
      (o) => o.id === 'plain-html',
    )!;
    expect(opt.worktree?.service).toBe('python3 -m http.server $PORT --bind 0.0.0.0');
    for (const p of PRESETS.filter((x) => x.type === 'static_site' && x.id !== 'static-plain')) {
      expect(p.starter).toBeNull();
    }
    for (const p of PRESETS.filter((x) => x.starter !== null)) expect(p.starter).toBe('static-plain');
  });

  it('every type lists an Auto preset first: every dimension that applies is "agent", no starter', () => {
    for (const t of PROJECT_TYPES) {
      const [first] = presetsForType(t.id);
      expect(first?.id, t.id).toBe(`auto-${t.id}`);
      expect(isAutoPreset(first!.id)).toBe(true);
      expect(first!.label).toBe('Auto — let the agent choose');
      expect(first!.description).toMatch(/vision/i);
      expect(first!.starter).toBeNull();
      for (const d of STACK_DIMENSIONS) {
        const applies = optionsForType(d.id, t.id).length > 0;
        expect(first!.choices[d.id], `${t.id}.${d.id}`).toBe(applies ? 'agent' : 'none');
      }
      // the generic steps come from the final choices in the Bootstrap ticket, not from the preset
      expect(first!.bootstrap).toEqual([]);
    }
    expect(isAutoPreset('static-plain')).toBe(false);
    expect(isAutoPreset('custom-blank')).toBe(false);
  });

  it('every preset says what it is best for and what it costs, in one short sentence each', () => {
    for (const p of PRESETS) {
      expect(p.bestFor, p.id).toMatch(/^Best for \S/);
      for (const text of [p.bestFor, p.tradeoff]) {
        expect(text.trim(), p.id).toBe(text);
        expect(text.length, `${p.id}: ${text}`).toBeGreaterThan(15);
        expect(text.length, `${p.id}: ${text}`).toBeLessThanOrEqual(140);
        expect(text, p.id).toMatch(/\.$/);
        expect(text, p.id).not.toMatch(/\n/);
      }
    }
  });

  it('every dimension says what it affects and every option what it is best for', () => {
    for (const d of STACK_DIMENSIONS) {
      expect(d.affects.length, d.id).toBeGreaterThan(15);
      expect(d.affects.length, d.id).toBeLessThanOrEqual(140);
      expect(d.affects.trim()).toBe(d.affects);
      for (const o of d.options) {
        expect(o.bestFor.trim(), o.id).toBe(o.bestFor);
        expect(o.bestFor.length, o.id).toBeGreaterThan(10);
        expect(o.bestFor.length, `${o.id}: ${o.bestFor}`).toBeLessThanOrEqual(140);
        expect(o.bestFor, o.id).toMatch(/\.$/);
      }
    }
  });

  it('a vision is required for Auto and whenever three or more primary dimensions are left to the agent', () => {
    expect(VISION_MIN_LENGTH).toBe(20);
    expect(visionRequired('auto-static_site', {})).toBe(true);
    expect(visionRequired('static-plain', getPreset('static-plain')!.choices)).toBe(false);
    expect(visionRequired(undefined, { frontend: 'agent', backend: 'agent' })).toBe(false);
    expect(visionRequired(undefined, { frontend: 'agent', backend: 'agent', deploy: 'agent' })).toBe(true);
    // the advanced dimensions do not count
    expect(
      visionRequired(undefined, { frontend: 'agent', language: 'agent', styling: 'agent', testing: 'agent' }),
    ).toBe(false);
    expect(visionRequired('custom-blank', getPreset('custom-blank')!.choices)).toBe(true);
  });

  it('preset bootstrap fragments are preset-specific only (no generic checks step)', () => {
    for (const p of PRESETS) expect(p.bootstrap.join('\n'), p.id).not.toMatch(/build gate runs the approved/);
  });

  it('exposes version policies', () => {
    expect(VERSION_POLICIES.length).toBe(4);
  });
});

describe('StackChoice', () => {
  it('accepts option id, none, agent and {other}', () => {
    expect(StackChoice.safeParse('react-vite').success).toBe(true);
    expect(StackChoice.safeParse('none').success).toBe(true);
    expect(StackChoice.safeParse('agent').success).toBe(true);
    expect(StackChoice.safeParse({ other: 'Elm' }).success).toBe(true);
  });
  it('rejects empty, oversized other, and unknown shapes', () => {
    expect(StackChoice.safeParse('').success).toBe(false);
    expect(StackChoice.safeParse({ other: 'x'.repeat(201) }).success).toBe(false);
    expect(StackChoice.safeParse({ other: 'x'.repeat(200) }).success).toBe(true);
    expect(StackChoice.safeParse({ other: '' }).success).toBe(false);
    expect(StackChoice.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(StackChoice.safeParse(3).success).toBe(false);
  });
  it('ProjectChoices rejects unknown dimensions', () => {
    expect(ProjectChoices.safeParse({ frontend: 'x', auth: 'none' }).success).toBe(true);
    expect(ProjectChoices.safeParse({ nonsense: 'x' }).success).toBe(false);
  });
});

describe('CreateProjectBody back-compat', () => {
  it('parses an old payload unchanged, new fields absent', () => {
    const old = {
      name: 'Legacy',
      mode: 'wizard' as const,
      repoUrl: 'https://example.com/a/b.git',
      defaultBranch: 'trunk',
      appType: 'fullstack' as const,
      description: 'desc',
      techStack: { language: 'TS', frontend: 'React', backend: '', database: '', styling: '', testing: '' },
      architectureNotes: 'notes',
      referenceDocs: 'docs',
      initGit: true,
      seedStarterTickets: true,
    };
    const out = CreateProjectBody.parse(old);
    expect(out).toEqual(old);
    expect(out).not.toHaveProperty('source');
    expect(CreateProjectBody.parse({ name: 'x' })).toEqual({
      name: 'x',
      mode: 'manual',
      defaultBranch: 'main',
      appType: 'custom',
      description: '',
      seedStarterTickets: false,
    });
  });
  it('accepts v2 fields', () => {
    const out = CreateProjectBody.parse({
      name: 'New',
      source: 'new',
      appType: 'static_site',
      presetId: 'static-plain',
      choices: { frontend: 'plain-html', auth: 'none', deploy: { other: 'rsync' } },
      gates: { secretGuardGate: true, antiSlopGate: false },
      startFactory: true,
      vision: 'A site',
    });
    expect(out.source).toBe('new');
    expect(out.gates).toEqual({ secretGuardGate: true, antiSlopGate: false });
    expect(CreateProjectBody.safeParse({ name: 'x', source: 'bogus' }).success).toBe(false);
    expect(CreateProjectBody.safeParse({ name: 'x', gates: { nope: true } }).success).toBe(false);
  });
  it('rejects control characters and newlines in {other}', () => {
    expect(StackChoice.safeParse({ other: 'rsync to box' }).success).toBe(true);
    expect(StackChoice.safeParse({ other: 'a\nb' }).success).toBe(false);
    expect(StackChoice.safeParse({ other: 'a\u0000b' }).success).toBe(false);
    expect(StackChoice.safeParse({ other: 'a\tb' }).success).toBe(false);
  });

  it('validates folder names and requires one for import_folder', () => {
    const ok = CreateProjectBody.safeParse({ name: 'x', source: 'import_folder', folder: 'my-app' });
    expect(ok.success).toBe(true);
    for (const folder of ['a/b', 'a\\b', '..', '.', 'a\u0000b']) {
      expect(CreateProjectBody.safeParse({ name: 'x', source: 'import_folder', folder }).success).toBe(false);
    }
    expect(CreateProjectBody.safeParse({ name: 'x', source: 'import_folder' }).success).toBe(false);
    expect(CreateProjectBody.safeParse({ name: 'x', source: 'new' }).success).toBe(true);
    expect(CreateProjectBody.safeParse({ name: 'x', source: 'import_url' }).success).toBe(false);
    expect(
      CreateProjectBody.safeParse({ name: 'x', source: 'import_url', repoUrl: 'https://h/r.git' }).success,
    ).toBe(true);
  });
});
