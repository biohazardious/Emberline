import { getPreset, type ProjectDetectResponse } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildAdoptBody,
  buildCreateBody,
  canVisit,
  draftOf,
  hasImportableFolders,
  initialWizardState,
  isNameConflict,
  isDirty,
  isStepLocked,
  isStepValid,
  mergeDefaults,
  nameProblem,
  parseDraft,
  presetChoices,
  previousStep,
  repoNameFromUrl,
  stepProblem,
  stepsFor,
  stripUrlCredentials,
  type WizardAction,
  type WizardState,
  wizardReducer,
  worktreeYmlImportNote,
} from './wizardLogic';

const run = (actions: WizardAction[], from: WizardState = initialWizardState()) => actions.reduce(wizardReducer, from);

/** A new project with a valid name, type and preset, standing on the type step. */
const typed = () =>
  run([
    { type: 'source', source: 'preset' },
    { type: 'go', step: 'type' },
    { type: 'field', field: 'name', value: 'Shop' },
    { type: 'appType', appType: 'web_saas' },
  ]);

const detectResponse = (o: Partial<ProjectDetectResponse['detected']> = {}): ProjectDetectResponse => ({
  detected: {
    appType: 'web_saas',
    choices: { frontend: 'react-vite', backend: 'flask-nonexistent' },
    commands: { setup: [], services: [] },
    files: { projectMd: false, claudeMd: true, agentsMd: false, worktreeYml: false },
    worktreeYml: null,
    ...o,
  },
  suggestions: { projectMd: '# P', worktreeYml: 'version: 1\n' },
});

describe('stepsFor', () => {
  it('lists the steps of each flow', () => {
    expect(stepsFor(null)).toEqual(['start', 'type', 'stack', 'factory', 'summary']);
    expect(stepsFor('preset')).toEqual(['start', 'type', 'stack', 'factory', 'summary']);
    expect(stepsFor('blank')).toEqual(['start', 'type', 'stack', 'factory', 'summary']);
    expect(stepsFor('import_url')).toEqual(['start', 'repo', 'import', 'stack', 'factory', 'summary']);
    expect(stepsFor('import_folder')).toEqual(['start', 'repo', 'import', 'stack', 'factory', 'summary']);
  });
});

describe('per-step validation', () => {
  it('needs a source on the start step', () => {
    const s = initialWizardState();
    expect(isStepValid(s, 'start')).toBe(false);
    expect(isStepValid(wizardReducer(s, { type: 'source', source: 'preset' }), 'start')).toBe(true);
  });

  it('needs a name with a letter or digit, a type and a preset for new projects', () => {
    const s = run([{ type: 'source', source: 'preset' }]);
    expect(stepProblem(s, 'type')).toMatch(/name/i);
    const named = wizardReducer(s, { type: 'field', field: 'name', value: 'Shop' });
    expect(stepProblem(named, 'type')).toMatch(/type/i);
    expect(isStepValid(typed(), 'type')).toBe(true);
    expect(nameProblem('  ')).not.toBeNull();
    expect(nameProblem('!!!')).not.toBeNull();
    expect(nameProblem('x'.repeat(81))).not.toBeNull();
    expect(nameProblem('Şirket')).toBeNull();
  });

  it('picks the first preset of a type and refuses a preset of another type', () => {
    const s = typed();
    expect(s.presetId).toBe('web-react-fastify');
    const wrong = { ...s, presetId: 'static-plain' };
    expect(stepProblem(wrong, 'type')).toMatch(/preset/i);
  });

  it('validates the import URL with the protocol schema and needs a branch', () => {
    const s = run([
      { type: 'source', source: 'import_url' },
      { type: 'go', step: 'repo' },
      { type: 'field', field: 'repoUrl', value: 'ftp://example.com/x.git' },
    ]);
    expect(stepProblem(s, 'repo')).toMatch(/url/i);
    const ok = wizardReducer(s, { type: 'field', field: 'repoUrl', value: 'https://github.com/acme/shop.git' });
    expect(isStepValid(ok, 'repo')).toBe(true);
    expect(stepProblem({ ...ok, defaultBranch: '-bad' }, 'repo')).toMatch(/branch/i);
  });

  it('needs a folder for a folder import', () => {
    const s = run([{ type: 'source', source: 'import_folder' }]);
    expect(stepProblem(s, 'repo')).toMatch(/folder/i);
    const picked = wizardReducer(s, { type: 'field', field: 'folder', value: 'old-app' });
    expect(isStepValid(picked, 'repo')).toBe(true);
  });

  it('is invalid on the import step until detection finished', () => {
    const s = run([
      { type: 'source', source: 'import_folder' },
      { type: 'field', field: 'folder', value: 'old-app' },
      { type: 'importCreated', projectId: 'p1' },
    ]);
    expect(isStepValid(s, 'import')).toBe(false);
    expect(isStepValid(wizardReducer(s, { type: 'detected', detect: detectResponse() }), 'import')).toBe(true);
  });

  it('refuses an empty or multi-line Other choice on the stack step', () => {
    const s = typed();
    expect(isStepValid(s, 'stack')).toBe(true);
    const blank = wizardReducer(s, { type: 'choice', dimension: 'frontend', value: { other: '  ' } });
    expect(stepProblem(blank, 'stack')).toMatch(/frontend/i);
    const multi = wizardReducer(s, { type: 'choice', dimension: 'frontend', value: { other: 'a\nb' } });
    expect(isStepValid(multi, 'stack')).toBe(false);
    const ok = wizardReducer(s, { type: 'choice', dimension: 'frontend', value: { other: 'Elm' } });
    expect(isStepValid(ok, 'stack')).toBe(true);
  });

  it('needs a vision to start the factory on an imported project', () => {
    const s = run([
      { type: 'source', source: 'import_folder' },
      { type: 'field', field: 'folder', value: 'old-app' },
      { type: 'importCreated', projectId: 'p1' },
      { type: 'detected', detect: detectResponse() },
      { type: 'field', field: 'startFactory', value: true },
    ]);
    expect(stepProblem(s, 'factory')).toMatch(/vision/i);
    expect(isStepValid(wizardReducer(s, { type: 'field', field: 'vision', value: 'Add a cart' }), 'factory')).toBe(true);
    expect(isStepValid(wizardReducer(s, { type: 'field', field: 'startFactory', value: false }), 'factory')).toBe(true);
  });
});

describe('rail reachability', () => {
  it('only offers the start step on a fresh wizard', () => {
    const s = initialWizardState();
    expect(canVisit(s, 'start')).toBe(true);
    expect(canVisit(s, 'type')).toBe(false);
    expect(canVisit(s, 'summary')).toBe(false);
  });

  it('never jumps forward to a step that was not reached, even when the steps before it are valid', () => {
    const s = typed();
    expect(canVisit(s, 'stack')).toBe(false);
    expect(canVisit(s, 'summary')).toBe(false);
  });

  it('goes back freely and forward again only up to the furthest step while the steps before are valid', () => {
    const at = run([{ type: 'go', step: 'stack' }, { type: 'go', step: 'factory' }, { type: 'go', step: 'type' }], typed());
    expect(at.step).toBe('type');
    expect(canVisit(at, 'start')).toBe(true);
    expect(canVisit(at, 'factory')).toBe(true);
    expect(canVisit(at, 'summary')).toBe(false);
    const broken = wizardReducer(at, { type: 'field', field: 'name', value: '' });
    expect(canVisit(broken, 'stack')).toBe(false);
    expect(canVisit(broken, 'start')).toBe(true);
  });

  it('ignores a go to a step it cannot visit', () => {
    const s = initialWizardState();
    expect(wizardReducer(s, { type: 'go', step: 'summary' }).step).toBe('start');
  });

  it('locks the steps before an import once the project exists', () => {
    const s = run([
      { type: 'source', source: 'import_url' },
      { type: 'go', step: 'repo' },
      { type: 'field', field: 'repoUrl', value: 'https://github.com/acme/shop.git' },
      { type: 'importCreated', projectId: 'p1' },
    ]);
    expect(s.step).toBe('import');
    expect(isStepLocked(s, 'start')).toBe(true);
    expect(isStepLocked(s, 'repo')).toBe(true);
    expect(canVisit(s, 'repo')).toBe(false);
    const detected = wizardReducer(s, { type: 'detected', detect: detectResponse() });
    expect(detected.step).toBe('stack');
    expect(isStepLocked(detected, 'import')).toBe(true);
    expect(previousStep(detected)).toBeNull();
  });

  it('returns to the repository step when an import is cancelled', () => {
    const s = run([
      { type: 'source', source: 'import_url' },
      { type: 'go', step: 'repo' },
      { type: 'field', field: 'repoUrl', value: 'https://github.com/acme/shop.git' },
      { type: 'importCreated', projectId: 'p1' },
      { type: 'importCancelled' },
    ]);
    expect(s.step).toBe('repo');
    expect(s.importProjectId).toBeNull();
    expect(canVisit(s, 'start')).toBe(true);
  });
});

describe('dirty-dimension merge', () => {
  it('fills every dimension from the preset, unset ones as "agent"', () => {
    const c = presetChoices(getPreset('custom-blank')!);
    expect(c.frontend).toBe('agent');
    expect(c.styling).toBe('agent');
    expect(presetChoices(getPreset('static-plain')!).frontend).toBe('plain-html');
  });

  it('replaces untouched dimensions with the new defaults', () => {
    const out = mergeDefaults({ frontend: 'react-vite' }, [], { frontend: 'plain-html' }, 'static_site');
    expect(out.choices.frontend).toBe('plain-html');
  });

  it('keeps an edited dimension that is valid for the new type', () => {
    const out = mergeDefaults({ deploy: 'docker-compose' }, ['deploy'], { deploy: 'static-hosting' }, 'web_saas');
    expect(out.choices.deploy).toBe('docker-compose');
    expect(out.dirty).toEqual(['deploy']);
  });

  it('drops an edited option id that does not apply to the new type', () => {
    const out = mergeDefaults({ frontend: 'nextjs' }, ['frontend'], { frontend: 'plain-html' }, 'static_site');
    expect(out.choices.frontend).toBe('plain-html');
    expect(out.dirty).toEqual([]);
  });

  it('always keeps an edited none, agent or Other', () => {
    const out = mergeDefaults(
      { frontend: 'none', backend: 'agent', database: { other: 'DuckDB' } },
      ['frontend', 'backend', 'database'],
      { frontend: 'plain-html', backend: 'fastify', database: 'sqlite-drizzle' },
      'static_site',
    );
    expect(out.choices).toMatchObject({ frontend: 'none', backend: 'agent', database: { other: 'DuckDB' } });
  });

  it('keeps edited dimensions across a type change and a preset change in the reducer', () => {
    const edited = wizardReducer(typed(), { type: 'choice', dimension: 'auth', value: 'none' });
    expect(edited.dirty).toEqual(['auth']);
    const retyped = wizardReducer(edited, { type: 'appType', appType: 'fullstack' });
    expect(retyped.presetId).toBe('fullstack-react-fastify');
    expect(retyped.choices.auth).toBe('none');
    expect(retyped.choices.frontend).toBe('react-vite');
    const represet = wizardReducer(retyped, { type: 'preset', presetId: 'fullstack-nextjs' });
    expect(represet.choices.frontend).toBe('nextjs');
    expect(represet.choices.auth).toBe('none');
  });

  it('prefills an import from detection, replacing unknown or foreign options with "agent"', () => {
    const s = run([
      { type: 'source', source: 'import_folder' },
      { type: 'field', field: 'folder', value: 'old-app' },
      { type: 'importCreated', projectId: 'p1' },
      { type: 'detected', detect: detectResponse() },
    ]);
    expect(s.appType).toBe('web_saas');
    expect(s.choices.frontend).toBe('react-vite');
    expect(s.choices.backend).toBe('agent');
    expect(s.choices.deploy).toBe('agent');
    expect(s.dirty).toEqual([]);
    // Only missing files with a suggestion are ticked by default.
    expect(s.write).toEqual(['projectMd', 'worktreeYml']);
  });
});

describe('body building', () => {
  it('builds a new-project body from the preset flow', () => {
    const s = run(
      [
        { type: 'field', field: 'vision', value: '  A shop  ' },
        { type: 'choice', dimension: 'database', value: { other: ' DuckDB ' } },
        { type: 'gate', key: 'antiSlopGate', choice: 'off' },
        { type: 'gate', key: 'secretGuardGate', choice: 'on' },
        { type: 'gate', key: 'secretGuardGate', choice: 'inherit' },
        { type: 'field', field: 'startFactory', value: false },
      ],
      typed(),
    );
    const body = buildCreateBody(s);
    expect(body).toMatchObject({
      name: 'Shop',
      source: 'new',
      mode: 'wizard',
      appType: 'web_saas',
      presetId: 'web-react-fastify',
      vision: 'A shop',
      startFactory: false,
      defaultBranch: 'main',
      gates: { antiSlopGate: false },
      techStack: { versionPolicy: 'Latest Stable / LTS' },
    });
    expect(body.choices?.database).toEqual({ other: 'DuckDB' });
    expect(body.choices?.frontend).toBe('react-vite');
    expect('referenceDocs' in body).toBe(false);
    expect('repoUrl' in body).toBe(false);
  });

  it('builds a blank project as the custom-blank preset', () => {
    const s = run([{ type: 'source', source: 'blank' }, { type: 'field', field: 'name', value: 'Lab' }]);
    expect(s.appType).toBe('custom');
    expect(buildCreateBody(s)).toMatchObject({ source: 'new', appType: 'custom', presetId: 'custom-blank', startFactory: true });
  });

  it('builds an import_url body with the branch and an import_folder body with the folder', () => {
    const url = run([
      { type: 'source', source: 'import_url' },
      { type: 'field', field: 'repoUrl', value: ' https://github.com/acme/shop.git ' },
      { type: 'field', field: 'defaultBranch', value: 'develop' },
    ]);
    expect(url.name).toBe('shop');
    expect(buildCreateBody(url)).toEqual({ name: 'shop', source: 'import_url', repoUrl: 'https://github.com/acme/shop.git', defaultBranch: 'develop' });

    const folder = run([{ type: 'source', source: 'import_folder' }, { type: 'field', field: 'folder', value: 'old-app' }]);
    expect(folder.name).toBe('old-app');
    expect(buildCreateBody(folder)).toEqual({ name: 'old-app', source: 'import_folder', folder: 'old-app' });
  });

  it('follows the URL or folder with the name until the person types one', () => {
    const s = run([
      { type: 'source', source: 'import_url' },
      { type: 'field', field: 'repoUrl', value: 'git@github.com:acme/shop.git' },
      { type: 'field', field: 'repoUrl', value: 'git@github.com:acme/store.git' },
    ]);
    expect(s.name).toBe('store');
    const typedName = run([
      { type: 'field', field: 'name', value: 'Mine' },
      { type: 'field', field: 'repoUrl', value: 'https://x.org/a/other' },
    ], s);
    expect(typedName.name).toBe('Mine');
    expect(repoNameFromUrl('https://github.com/acme/shop.git/')).toBe('shop');
    expect(repoNameFromUrl('')).toBe('');
  });

  it('builds an adopt body: ticked missing files, gates, factory and vision', () => {
    const s = run([
      { type: 'source', source: 'import_folder' },
      { type: 'field', field: 'folder', value: 'old-app' },
      { type: 'importCreated', projectId: 'p1' },
      { type: 'detected', detect: detectResponse() },
      { type: 'write', file: 'worktreeYml', on: false },
      { type: 'field', field: 'startFactory', value: true },
      { type: 'field', field: 'vision', value: 'Add a cart' },
      { type: 'gate', key: 'crossProviderCritic', choice: 'on' },
    ]);
    expect(buildAdoptBody(s)).toEqual({
      appType: 'web_saas',
      choices: expect.objectContaining({ frontend: 'react-vite', backend: 'agent' }),
      gates: { crossProviderCritic: true },
      write: ['projectMd'],
      startFactory: true,
      vision: 'Add a cart',
      approveWorktreeYml: false,
    });
  });

  it('approves the repository worktree.yml by its sha256 only when it is approvable and never also writes one', () => {
    const sha = 'c'.repeat(64);
    const own = { content: 'version: 1\n', sha256: sha, errors: [], notCommitted: false, workingTreeDiffers: false };
    const detect = detectResponse({ files: { projectMd: false, claudeMd: false, agentsMd: false, worktreeYml: true }, worktreeYml: own });
    const s = run([
      { type: 'source', source: 'import_folder' },
      { type: 'field', field: 'folder', value: 'old-app' },
      { type: 'importCreated', projectId: 'p1' },
      { type: 'detected', detect },
      { type: 'write', file: 'worktreeYml', on: true },
      { type: 'approveWorktreeYml', on: true },
    ]);
    const body = buildAdoptBody(s);
    expect(body.approveWorktreeYml).toBe(true);
    expect(body.worktreeYmlSha256).toBe(sha);
    expect(body.write).not.toContain('worktreeYml');

    const broken = { ...detect, detected: { ...detect.detected, worktreeYml: { ...own, errors: ['bad'] } } };
    const s2 = run([{ type: 'detected', detect: broken }, { type: 'approveWorktreeYml', on: true }], {
      ...s,
      approveWorktreeYml: false,
    });
    expect(buildAdoptBody(s2).approveWorktreeYml).toBe(false);
    expect('worktreeYmlSha256' in buildAdoptBody(s2)).toBe(false);
  });
});

describe('drafts', () => {
  it('has nothing to keep for a fresh wizard or an import that already created its project', () => {
    expect(isDirty(initialWizardState())).toBe(false);
    expect(draftOf(initialWizardState())).toBeNull();
    const imported = run([
      { type: 'source', source: 'import_folder' },
      { type: 'field', field: 'folder', value: 'old-app' },
      { type: 'importCreated', projectId: 'p1' },
    ]);
    expect(isDirty(imported)).toBe(true);
    expect(draftOf(imported)).toBeNull();
  });

  it('round-trips a draft and restores it into the reducer', () => {
    const s = run([{ type: 'go', step: 'stack' }, { type: 'choice', dimension: 'auth', value: { other: 'Passkeys' } }], typed());
    const raw = JSON.stringify(draftOf(s));
    const draft = parseDraft(raw);
    expect(draft).not.toBeNull();
    const restored = wizardReducer(initialWizardState(), { type: 'restore', draft: draft! });
    expect(restored.name).toBe('Shop');
    expect(restored.step).toBe('stack');
    expect(restored.choices.auth).toEqual({ other: 'Passkeys' });
    expect(restored.dirty).toEqual(['auth']);
    expect(canVisit(restored, 'type')).toBe(true);
  });

  it('ignores a corrupt or foreign draft', () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('{not json')).toBeNull();
    expect(parseDraft('[]')).toBeNull();
    expect(parseDraft(JSON.stringify({ v: 99, name: 'x' }))).toBeNull();
    expect(parseDraft(JSON.stringify({ v: 1, name: 42 }))).toBeNull();
  });

  it('drops invalid fields of a draft and clamps its step to one it can reach', () => {
    const draft = parseDraft(
      JSON.stringify({
        v: 1,
        step: 'summary',
        source: 'preset',
        name: 'Shop',
        appType: 'not-a-type',
        presetId: 'web-react-fastify',
        choices: { frontend: { other: 'x\ny' }, auth: 'none' },
        dirty: ['auth', 'nope'],
        gates: { antiSlopGate: 'yes' },
      }),
    );
    expect(draft).not.toBeNull();
    const restored = wizardReducer(initialWizardState(), { type: 'restore', draft: draft! });
    expect(restored.appType).toBeNull();
    expect(restored.presetId).toBeNull();
    expect(restored.gates).toEqual({});
    expect(restored.dirty).toEqual(['auth']);
    expect(restored.step).toBe('type');
  });
});

describe('credentials never reach the draft', () => {
  it('strips userinfo from scheme URLs and keeps an ssh user name', () => {
    expect(stripUrlCredentials('https://user:ghp_secret@github.com/acme/shop.git')).toBe('https://github.com/acme/shop.git');
    expect(stripUrlCredentials('https://ghp_secret@github.com/acme/shop.git')).toBe('https://github.com/acme/shop.git');
    expect(stripUrlCredentials('ssh://git:pw@host.example/acme/shop.git')).toBe('ssh://git@host.example/acme/shop.git');
    expect(stripUrlCredentials('ssh://git@host.example/acme/shop.git')).toBe('ssh://git@host.example/acme/shop.git');
    expect(stripUrlCredentials('git@github.com:acme/shop.git')).toBe('git@github.com:acme/shop.git');
    expect(stripUrlCredentials('https://github.com/a/b?x=a@b')).toBe('https://github.com/a/b?x=a@b');
  });

  it('saves and restores the repository URL without its token', () => {
    const s = run([
      { type: 'source', source: 'import_url' },
      { type: 'field', field: 'repoUrl', value: 'https://me:tok@github.com/acme/shop.git' },
    ]);
    expect(s.repoUrl).toContain('tok');
    const raw = JSON.stringify(draftOf(s));
    expect(raw).not.toContain('tok');
    expect(draftOf(s)?.repoUrl).toBe('https://github.com/acme/shop.git');
    const planted = JSON.stringify({ v: 1, source: 'import_url', repoUrl: 'https://me:tok@github.com/x.git' });
    expect(parseDraft(planted)?.repoUrl).toBe('https://github.com/x.git');
  });
});

describe('import helpers', () => {
  it('offers the folder source only when a folder is a git repository', () => {
    const f = (isGitRepo: boolean) => ({ name: 'a', path: '/w/a', isGitRepo, hasRemote: false });
    expect(hasImportableFolders([])).toBe(false);
    expect(hasImportableFolders([f(false)])).toBe(false);
    expect(hasImportableFolders([f(false), f(true)])).toBe(true);
  });

  it('puts a 409 on the name field only for a taken name or an existing directory', () => {
    expect(isNameConflict({ status: 409, code: 'name_taken' })).toBe(true);
    expect(isNameConflict({ status: 409, code: 'directory_exists' })).toBe(true);
    expect(isNameConflict({ status: 409, code: 'being_created' })).toBe(false);
    expect(isNameConflict({ status: 409, code: 'conflict' })).toBe(false);
    expect(isNameConflict({ status: 400, code: 'name_taken' })).toBe(false);
    expect(isNameConflict(new Error('a project with slug "x" already exists'))).toBe(false);
  });
});

describe('worktreeYmlImportNote', () => {
  const base = (o: Partial<WizardState>): WizardState => ({ ...initialWizardState(), source: 'import_folder', ...o });

  it('says the generated worktree.yml is approved and its setup may run the repo install scripts', () => {
    const note = worktreeYmlImportNote(base({ detect: detectResponse(), write: ['worktreeYml'] }));
    expect(note).toContain('generated .emberline/worktree.yml is approved');
    expect(note).toContain("may run the repository's own install scripts");
  });

  it("says the same of the repository's own file when it is approved", () => {
    const own = { content: 'version: 1\n', sha256: 'a'.repeat(64), errors: [], notCommitted: false, workingTreeDiffers: false };
    const detect = detectResponse({ files: { projectMd: false, claudeMd: true, agentsMd: false, worktreeYml: true }, worktreeYml: own });
    const note = worktreeYmlImportNote(base({ detect, approveWorktreeYml: true }));
    expect(note).toContain("repository's .emberline/worktree.yml is approved");
    expect(note).toContain('install scripts');
    expect(worktreeYmlImportNote(base({ detect, approveWorktreeYml: false }))).toBeNull();
  });

  it('nothing when no worktree.yml gets approved', () => {
    expect(worktreeYmlImportNote(base({ detect: detectResponse(), write: [] }))).toBeNull();
  });
});
