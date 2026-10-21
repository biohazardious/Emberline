import {
  DOCKER_ENGINE_OFF_TEXT,
  type DockerCleanupState,
  type DockerContainer,
  type DockerProject,
  type DockerProjectOwner,
} from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import {
  cleanupLines,
  cleanupResultText,
  confirmText,
  containerStateTone,
  DOCKER_GROUPS,
  dockerErrorDetails,
  groupDockerProjects,
  ownerBadges,
  ownerSummary,
  actionsFor,
  doneStillCurrent,
  portLink,
  projectServices,
  projectStatusTone,
  runOwnerName,
} from './dockerPage';

type AgentOwner = Extract<DockerProjectOwner, { kind: 'agent' }>;
type PreviewOwner = Extract<DockerProjectOwner, { kind: 'preview' }>;
type RunFields = Omit<AgentOwner, 'kind'>;

const runFields: RunFields = {
  runId: 'abcd1234-0000-4000-8000-000000000000',
  runTitle: 'SHOP-1 Login',
  ticketId: 't1',
  ticketKey: 'SHOP-1',
  ticketTitle: 'Login',
  projectId: 'p1',
  projectName: 'Shop',
  runState: 'working',
  live: false,
  inReview: false,
};

const agent = (over: Partial<RunFields> = {}): AgentOwner => ({ kind: 'agent', ...runFields, ...over });
const preview = (over: Partial<RunFields> = {}): PreviewOwner => ({ kind: 'preview', ...runFields, ...over });
const main: DockerProjectOwner = { kind: 'main', projectId: 'p1', projectName: 'Shop' };
const mainPreview: DockerProjectOwner = { kind: 'main', projectId: 'p1', projectName: 'Shop', preview: true };
const orphan: DockerProjectOwner = { kind: 'orphan' };

function container(over: Partial<DockerContainer> = {}): DockerContainer {
  return {
    name: 'emberline-abcd1234-web-1',
    service: 'web',
    state: 'running',
    status: 'Up 2 minutes',
    ports: [],
    image: 'nginx:alpine',
    createdAt: '2026-10-18 08:00:00 +0000 UTC',
    runningFor: '2 minutes ago',
    ...over,
  };
}

function project(
  name: string,
  owner: DockerProjectOwner,
  containers: DockerContainer[] = [],
  projectId: string | null = 'projectId' in owner ? owner.projectId : null,
): DockerProject {
  return { name, status: 'running(1)', owner, containers, stale: owner.kind === 'orphan', projectId };
}

describe('groupDockerProjects', () => {
  it('groups by owner kind in a fixed order and leaves out empty groups', () => {
    const projects = [
      project('emberline-0000aaaa', orphan),
      project('emberline-abcd1234-preview', preview()),
      project('emberline-abcd1234', agent()),
      project('emberline-ffff0000', agent({ runId: 'ffff0000-x' })),
    ];
    const groups = groupDockerProjects(projects);
    expect(groups.map((g) => g.kind)).toEqual(['agent', 'preview', 'orphan']);
    expect(groups[0]?.projects.map((p) => p.name)).toEqual(['emberline-abcd1234', 'emberline-ffff0000']);
    expect(groups[2]?.label).toBe('Leftovers — removed by the automatic cleanup');
  });

  it("lists main's container preview under Previews, Build & Verify's project under Build & Verify", () => {
    const groups = groupDockerProjects([
      project('emberline-main-11112222', main),
      project('emberline-main-11112222-preview', mainPreview),
      project('emberline-abcd1234-preview', preview()),
    ]);
    expect(groups.map((g) => [g.kind, g.projects.map((p) => p.name)])).toEqual([
      ['preview', ['emberline-main-11112222-preview', 'emberline-abcd1234-preview']],
      ['main', ['emberline-main-11112222']],
    ]);
  });

  it('labels the four groups', () => {
    expect(DOCKER_GROUPS.map((g) => [g.kind, g.label])).toEqual([
      ['agent', 'Agents'],
      ['preview', 'Previews'],
      ['main', 'Build & Verify'],
      ['orphan', 'Leftovers — removed by the automatic cleanup'],
    ]);
  });

  it('is empty without projects', () => {
    expect(groupDockerProjects([])).toEqual([]);
  });
});

describe('owner labels', () => {
  it('names a run by its ticket key, else its title, else its short id', () => {
    expect(runOwnerName(agent())).toBe('SHOP-1');
    expect(runOwnerName(agent({ ticketKey: null }))).toBe('SHOP-1 Login');
    expect(runOwnerName(agent({ ticketKey: null, runTitle: null }))).toBe('run abcd1234');
  });

  it('links runs to their Review page and main projects to their board', () => {
    expect(ownerSummary(agent())).toEqual({
      prefix: 'Agent of',
      text: 'SHOP-1',
      detail: 'Login · Shop',
      href: '/runs/abcd1234-0000-4000-8000-000000000000/review',
    });
    expect(ownerSummary(preview({ ticketKey: null, ticketTitle: null, projectName: null }))).toEqual({
      prefix: 'Preview of',
      text: 'SHOP-1 Login',
      detail: null,
      href: '/runs/abcd1234-0000-4000-8000-000000000000/review',
    });
    expect(ownerSummary(main)).toEqual({
      prefix: 'Build & Verify of',
      text: 'Shop',
      detail: null,
      href: '/projects/p1/board',
    });
    expect(ownerSummary(mainPreview)).toEqual({
      prefix: 'Preview of main ·',
      text: 'Shop',
      detail: null,
      href: '/projects/p1/board',
    });
    expect(ownerSummary(orphan)).toEqual({
      prefix: 'No run or project uses it',
      text: null,
      detail: null,
      href: null,
    });
  });

  it('marks a live agent and a run waiting in Review', () => {
    expect(ownerBadges(agent({ live: true }))).toEqual([{ text: 'agent running', tone: 'warn' }]);
    expect(ownerBadges(preview({ inReview: true }))).toEqual([{ text: 'in review', tone: 'soft' }]);
    expect(ownerBadges(agent())).toEqual([]);
    expect(ownerBadges(main)).toEqual([]);
    expect(ownerBadges(orphan)).toEqual([]);
  });
});

describe('confirmText', () => {
  it('says what Stop and Remove do', () => {
    expect(confirmText(project('emberline-0000aaaa', orphan), 'stop')).toEqual({
      question: 'Stop emberline-0000aaaa? Its containers are taken down; volumes and images stay.',
      warning: null,
    });
    expect(confirmText(project('emberline-main-11112222', main), 'remove')).toEqual({
      question:
        'Remove emberline-main-11112222? Its containers, volumes and the images it built are deleted.',
      warning: null,
    });
  });

  it('warns, without blocking, when the agent of the project is running', () => {
    expect(confirmText(project('emberline-abcd1234', agent({ live: true })), 'stop').warning).toBe(
      'The agent of SHOP-1 is running and may be using it.',
    );
    expect(
      confirmText(
        project('emberline-abcd1234', agent({ live: true, ticketKey: null, runTitle: null })),
        'remove',
      ).warning,
    ).toBe('The agent of run abcd1234 is running and may be using it.');
    expect(confirmText(project('emberline-abcd1234', agent({ live: false })), 'stop').warning).toBeNull();
  });

  it("says Stop on main's preview project ends main's container preview", () => {
    expect(confirmText(project('emberline-main-11112222-preview', mainPreview), 'remove')).toEqual({
      question:
        "Remove emberline-main-11112222-preview? Its containers, volumes and the images it built are deleted. Main's container preview stops if it is running.",
      warning: null,
    });
  });

  it("says a preview project's Stop ends the run's compose preview", () => {
    expect(confirmText(project('emberline-abcd1234-preview', preview()), 'stop')).toEqual({
      question:
        "Stop emberline-abcd1234-preview? Its containers are taken down; volumes and images stay. The run's compose preview stops if it is running.",
      warning: null,
    });
  });
});

describe('actionsFor', () => {
  it('offers only Remove for a leftover: a stopped one keeps its volumes and the cleanup no longer sees it', () => {
    expect(actionsFor(orphan)).toEqual(['remove']);
    expect(actionsFor(agent())).toEqual(['stop', 'remove']);
    expect(actionsFor(preview())).toEqual(['stop', 'remove']);
    expect(actionsFor(main)).toEqual(['stop', 'remove']);
  });
});

describe('doneStillCurrent', () => {
  const listed = [project('emberline-abcd1234', agent())];
  it('keeps "Stopped/Removed <name>" while the project stays gone, and drops it once it is listed again', () => {
    expect(
      doneStillCurrent({ project: 'emberline-deadbeef', text: 'Removed emberline-deadbeef.' }, listed),
    ).toBe(true);
    expect(
      doneStillCurrent({ project: 'emberline-abcd1234', text: 'Stopped emberline-abcd1234.' }, listed),
    ).toBe(false);
    expect(doneStillCurrent(null, listed)).toBe(false);
  });
});

describe('cleanupResultText', () => {
  it('counts the removed projects and says whether images were pruned', () => {
    expect(cleanupResultText({ removed: ['emberline-deadbeef'], listed: true, pruned: true })).toEqual({
      text: 'Removed 1 project (emberline-deadbeef); images were pruned.',
      ok: true,
    });
    expect(cleanupResultText({ removed: [], listed: true, pruned: false })).toEqual({
      text: 'Removed 0 projects; images were not pruned.',
      ok: true,
    });
    expect(
      cleanupResultText({ removed: ['emberline-a', 'emberline-b'], listed: true, pruned: true }).text,
    ).toBe('Removed 2 projects (emberline-a, emberline-b); images were pruned.');
  });

  it('says the listing failed and whether the prune still ran', () => {
    expect(
      cleanupResultText({
        removed: [],
        listed: false,
        pruned: true,
        error: 'docker compose ls failed (exit 1): boom',
      }),
    ).toEqual({
      text: "Couldn't list projects: docker compose ls failed (exit 1): boom; images were pruned.",
      ok: false,
    });
    expect(cleanupResultText({ removed: [], listed: false, pruned: false }).text).toBe(
      "Couldn't list projects: unknown error; images were not pruned.",
    );
  });
});

describe('cleanupLines', () => {
  const ago = (iso: string) => `ago(${iso})`;
  const state = (over: Partial<DockerCleanupState> = {}): DockerCleanupState => ({
    lastSweepAt: null,
    lastSweepRemoved: [],
    lastPruneAt: null,
    lastPruneOkAt: null,
    sweeping: false,
    ...over,
  });

  it('says nothing ran yet', () => {
    expect(cleanupLines(state(), ago)).toEqual({
      sweep: 'No cleanup has run since Emberline started.',
      prune: 'Images not pruned yet.',
    });
  });

  it('says when the last sweep and prune ran and how many projects went', () => {
    expect(
      cleanupLines(
        state({
          lastSweepAt: 'T1',
          lastSweepRemoved: ['emberline-a'],
          lastPruneAt: 'T2',
          lastPruneOkAt: 'T2',
        }),
        ago,
      ),
    ).toEqual({ sweep: 'Last cleanup ago(T1): removed 1 project.', prune: 'Images last pruned ago(T2).' });
    expect(cleanupLines(state({ lastSweepAt: 'T1' }), ago).sweep).toBe(
      'Last cleanup ago(T1): removed 0 projects.',
    );
  });

  it('says when the latest prune failed, and when one last succeeded', () => {
    expect(cleanupLines(state({ lastPruneAt: 'T3', lastPruneOkAt: 'T2' }), ago).prune).toBe(
      'Image prune last ran ago(T3) (failed). Images last pruned ago(T2).',
    );
    expect(cleanupLines(state({ lastPruneAt: 'T3' }), ago).prune).toBe(
      'Image prune last ran ago(T3) (failed). Images not pruned yet.',
    );
  });
});

describe('dockerErrorDetails', () => {
  it('adds the hint of an engine-off answer', () => {
    const hint = DOCKER_ENGINE_OFF_TEXT;
    const e = new ApiRequestError(409, 'docker_off', 'The Docker engine is off', {
      hint,
    });
    expect(dockerErrorDetails(e)).toEqual({
      message: `The Docker engine is off. ${hint}`,
      output: null,
    });
  });

  it('puts the hint in its own sentence after a message that ends in a full stop', () => {
    const e = new ApiRequestError(409, 'docker_off', 'The Docker engine is off.', { hint: DOCKER_ENGINE_OFF_TEXT });
    expect(dockerErrorDetails(e).message).toBe(`The Docker engine is off. ${DOCKER_ENGINE_OFF_TEXT}`);
  });

  it('keeps the output of a failed down for display as text', () => {
    const e = new ApiRequestError(502, 'docker_failed', 'docker compose down failed', {
      output: 'boom\nline 2',
    });
    expect(dockerErrorDetails(e)).toEqual({ message: 'docker compose down failed', output: 'boom\nline 2' });
  });

  it('passes other errors through', () => {
    expect(dockerErrorDetails(new ApiRequestError(400, 'bad_request', 'not an Emberline project'))).toEqual({
      message: 'not an Emberline project',
      output: null,
    });
    expect(dockerErrorDetails(new Error('network down'))).toEqual({ message: 'network down', output: null });
  });
});

describe('chips, ports and services', () => {
  it('tones container states', () => {
    expect(containerStateTone('running')).toBe('ok');
    expect(containerStateTone('restarting')).toBe('warn');
    expect(containerStateTone('paused')).toBe('warn');
    expect(containerStateTone('created')).toBe('warn');
    expect(containerStateTone('exited')).toBe('bad');
    expect(containerStateTone('dead')).toBe('bad');
    expect(containerStateTone('unknown')).toBeNull();
  });

  it('tones compose ls statuses', () => {
    expect(projectStatusTone('running(2)')).toBe('ok');
    expect(projectStatusTone('running(1), exited(1)')).toBe('warn');
    expect(projectStatusTone('exited(2)')).toBe('bad');
    expect(projectStatusTone('created(1)')).toBe('warn');
    expect(projectStatusTone(null)).toBeNull();
  });

  it("links a published port only when core gave it a URL (the engine's preview range)", () => {
    expect(portLink({ port: 4330, url: 'http://192.168.1.21:4330' })).toEqual({
      text: ':4330',
      href: 'http://192.168.1.21:4330',
    });
    expect(portLink({ port: 8080, url: null })).toEqual({ text: ':8080', href: null });
  });

  it("lists a project's services once, sorted", () => {
    const p = project('emberline-abcd1234', agent(), [
      container({ service: 'web' }),
      container({ service: 'db' }),
      container({ service: 'web', name: 'emberline-abcd1234-web-2' }),
      container({ service: null }),
    ]);
    expect(projectServices(p)).toEqual(['db', 'web']);
  });
});
