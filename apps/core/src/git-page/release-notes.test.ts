import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { readRepositorySettings } from '../db/project-settings.js';
import { tickets } from '../db/schema.js';
import { authHeaders, createTestApp, setupAndLogin, startGitGateway, type TestApp } from '../test-utils.js';
import { GitPageService } from './service.js';
import {
  buildReleaseNotesPrompt,
  MAX_PROMPT_BYTES,
  releaseRange,
  suggestVersion,
  truncateBytes,
} from './release-notes.js';

let t: TestApp;
let cookie: string;
let projectId: string;
let projectPath: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', projectPath, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    encoding: 'utf8',
  }).trim();
const commit = (file: string, subject: string) => {
  writeFileSync(path.join(projectPath, file), `${file}\n`);
  git('add', file);
  git('commit', '-q', '-m', subject);
};
const service = () =>
  new GitPageService(t.db, t.repository, {
    runs: t.runs,
    forge: t.forge,
    tickets: t.tickets,
    workspacesDir: t.config.workspacesDir,
  });
const draftUrl = () => `/api/projects/${projectId}/git/release/draft`;
const stored = () => readRepositorySettings(t.db, projectId).releaseDraft;
/** Git still runs for real; only the agent CLI (claude) is answered by `agent`. */
const stubAgent = (agent: (request: ExecRequest) => Promise<never>) =>
  setCommandExecutor((request) =>
    request.file === 'claude' ? agent(request) : localCommandExecutor(request),
  );
const answer = (structured: object) =>
  ({
    exitCode: 0,
    stdout: JSON.stringify({ structured_output: structured }),
    stderr: '',
    timedOut: false,
  }) as never;

beforeEach(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
  setCommandExecutor(localCommandExecutor);
  t = await createTestApp();
  await startGitGateway(t);
  cookie = await setupAndLogin(t.app);
  const made = (
    await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(cookie),
      payload: { name: 'Notes App', initGit: true },
    })
  ).json();
  projectId = made.project.id;
  projectPath = made.project.path;
  commit('a.txt', 'feat: a');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

describe('suggestVersion', () => {
  it.each([
    [null, 'minor', 'v0.1.0'],
    ['v0.8.0', 'patch', 'v0.8.1'],
    ['v0.8.3', 'minor', 'v0.9.0'],
    ['0.8.3', 'major', '1.0.0'],
    ['v1.2.3', 'major', 'v2.0.0'],
  ])('suggestVersion(%s, %s) = %s', (tag, bump, out) =>
    expect(suggestVersion(tag, bump as 'patch')).toBe(out),
  );
});

describe('releaseRange', () => {
  it("reads main's last tag from the branch, not from a tag that shares main's name", async () => {
    git('tag', 'v0.1.0');
    git('tag', 'main');
    commit('b.txt', 'feat: b');
    git('tag', 'v0.2.0');
    commit('c.txt', 'feat(EMB-3): c');
    const range = await releaseRange(projectPath, 'main', 'main');
    expect(range.baseTag).toBe('v0.2.0');
    expect(range.commits.map((c) => c.subject)).toEqual(['feat(EMB-3): c']);
  });
});

describe('release notes draft', () => {
  it('drafts notes from the commits since the last tag through the agent', async () => {
    git('tag', 'v0.8.0');
    commit('b.txt', 'feat(EMB-7): shiny thing');
    commit('c.txt', 'fix: a crash');
    const now = new Date();
    t.db
      .insert(tickets)
      .values({
        id: 'tk1',
        number: 7,
        position: 1,
        projectId,
        key: 'EMB-7',
        title: 'Make it shiny',
        status: 'done',
        createdAt: now,
        updatedAt: now,
      } as never)
      .run();
    const seen: ExecRequest[] = [];
    stubAgent(async (request) => {
      seen.push(request);
      return answer({ bump: 'minor', notes: '### Added\n- x' });
    });
    const svc = service();
    const draft = await svc.draftRelease(projectId);
    expect(draft).toMatchObject({ status: 'drafting', head: git('rev-parse', 'HEAD') });
    expect(stored()?.status).toBe('drafting');
    await svc.idle();
    expect(stored()).toMatchObject({
      status: 'ready',
      baseTag: 'v0.8.0',
      version: 'v0.9.0',
      bump: 'minor',
      notes: '### Added\n- x',
      agent: 'claude',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ target: 'runner', cwd: projectPath, timeoutMs: 5 * 60_000 });
    const prompt = seen[0]!.args!.join('\n');
    expect(prompt).toContain('feat(EMB-7): shiny thing');
    expect(prompt).toContain('EMB-7: Make it shiny');
    expect(prompt).toContain('fix: a crash');
    expect(prompt).not.toContain('feat: a\n');
    expect(prompt).toContain('Do NOT modify any files or run commands.');
  });

  it('a timeout leaves a failed draft with a reason', async () => {
    stubAgent(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) as never);
    const res = await t.app.inject({ method: 'POST', url: draftUrl(), headers: authHeaders(cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('drafting');
    await vi.waitFor(() => expect(stored()?.status).toBe('failed'));
    expect(stored()?.error).toMatch(/timed out/);
    expect(stored()?.notes).toBe('');
  });

  it('with no signed-in agent the draft fails at once with a reason', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const res = await t.app.inject({ method: 'POST', url: draftUrl(), headers: authHeaders(cookie) });
    expect(res.json()).toMatchObject({
      status: 'failed',
      error: 'No signed-in agent can write release notes; write them yourself below.',
    });
    expect(stored()?.status).toBe('failed');
  });

  it('stopping core does not wait for a draft, and a draft ending after it writes nothing', async () => {
    let release!: () => void;
    stubAgent(
      () =>
        new Promise((resolve) => {
          release = () => resolve(answer({ bump: 'patch', notes: 'late' }));
        }),
    );
    const svc = service();
    await svc.draftRelease(projectId);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await svc.stop(50);
    release();
    await svc.idle();
    expect(stored()?.status).toBe('drafting');
  });

  it('a drafting draft that no job owns reads as failed', async () => {
    let release!: () => void;
    stubAgent(
      () =>
        new Promise((resolve) => {
          release = () => resolve(answer({ bump: 'patch', notes: 'n' }));
        }),
    );
    const svc = service();
    await svc.draftRelease(projectId);
    expect(svc.releaseDraft(projectId)?.status).toBe('drafting');
    // As after a restart: the stored draft is still drafting, but this service has no job for it.
    expect(service().releaseDraft(projectId)).toMatchObject({
      status: 'failed',
      error: 'The draft was interrupted; draft again.',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await svc.idle();
    expect(svc.releaseDraft(projectId)?.status).toBe('ready');
  });
});

describe('buildReleaseNotesPrompt', () => {
  it('asks for Keep a Changelog sections and a bump', () => {
    const prompt = buildReleaseNotesPrompt({ baseTag: null, head: 'h', commits: [], diffstat: '' }, []);
    expect(prompt).toContain('### Added / ### Changed / ### Fixed / ### Security');
    expect(prompt).toContain(
      'Choose bump: major for breaking changes, minor for new features, patch otherwise.',
    );
  });

  it('keeps the prompt within one argument, saying what was left out', () => {
    const commits = Array.from({ length: 300 }, (_, i) => ({
      sha: String(i),
      subject: `feat: change ${i}\nsecond line`,
      body: 'x'.repeat(2_000),
    }));
    const prompt = buildReleaseNotesPrompt(
      { baseTag: 'v1.0.0', head: 'h', commits, omittedCommits: 12, diffstat: 'd'.repeat(20_000) },
      [{ key: 'EMB-1', title: 'two\nlines' }],
    );
    expect(Buffer.byteLength(prompt)).toBeLessThan(MAX_PROMPT_BYTES);
    expect(prompt).toContain('older commits omitted');
    expect(prompt).toContain('bodies were left out');
    expect(prompt).toContain('EMB-1: two lines');
    expect(prompt).toContain('feat: change 0 second line');
  });

  it('counts bytes, not characters: subjects and a diffstat in a wide script stay within one argument', () => {
    // Three bytes a character: 100 000 characters of these would be 300 000 bytes.
    const wide = '変'.repeat(290);
    const commits = Array.from({ length: 300 }, (_, i) => ({
      sha: String(i),
      subject: `feat: ${wide} ${i}`,
      body: '',
    }));
    const prompt = buildReleaseNotesPrompt(
      { baseTag: 'v1.0.0', head: 'h', commits, diffstat: '変'.repeat(60_000) },
      [],
    );
    expect(Buffer.byteLength(prompt)).toBeLessThan(MAX_PROMPT_BYTES);
    expect(prompt).toContain('older commits omitted');
    expect(prompt).not.toContain('\uFFFD');
  });

  it('counts ticket lines in the same byte budget: long titles in a wide script are cut, and the cut is said', () => {
    const wide = '変'.repeat(300);
    const commits = Array.from({ length: 40 }, (_, i) => ({
      sha: String(i),
      subject: `feat: ${wide} ${i}`,
      body: '',
    }));
    const titles = Array.from({ length: 100 }, (_, i) => ({ key: `EMB-${i}`, title: wide }));
    const prompt = buildReleaseNotesPrompt(
      { baseTag: 'v1.0.0', head: 'h', commits, diffstat: 'd'.repeat(20_000) },
      titles,
    );
    expect(Buffer.byteLength(prompt)).toBeLessThan(MAX_PROMPT_BYTES);
    // The commits come first and all fit; the tickets after them only as far as the budget goes.
    expect(prompt).not.toContain('older commits omitted');
    expect(prompt).toContain('- EMB-0: 変');
    expect(prompt).not.toContain('- EMB-99: ');
    expect(prompt).toMatch(/\(\d+ more tickets omitted\.\)/);
    expect(prompt).not.toContain('�');
  });

  it('truncateBytes never cuts a character in two', () => {
    expect(truncateBytes('ab', 5)).toBe('ab');
    expect(truncateBytes('a変b', 3)).toBe('a');
    expect(truncateBytes('a変b', 4)).toBe('a変');
    expect(truncateBytes('😀x', 3)).toBe('');
  });
});
