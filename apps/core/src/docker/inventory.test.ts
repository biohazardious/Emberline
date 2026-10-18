import { describe, expect, it } from 'vitest';
import { dockerPsArgs, systemDfArgs } from './compose.js';
import { composeProjectName, mainComposeProjectName, mainPreviewComposeProjectName, previewComposeProjectName } from './engine.js';
import {
  buildDockerProjects,
  composeProjectsInUse,
  type OwnershipFacts,
  type OwnershipRun,
  parseComposeLsRows,
  parseDockerLabels,
  parseDockerPs,
  parseHostPorts,
  parseSystemDf,
  resolveDockerOwner,
} from './inventory.js';

describe('inventory command lines', () => {
  it('one `docker ps -a` for every compose container, and `system df`, as JSON lines', () => {
    expect(dockerPsArgs()).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=com.docker.compose.project',
      '--format',
      '{{json .}}',
    ]);
    expect(systemDfArgs()).toEqual(['system', 'df', '--format', '{{json .}}']);
  });
});

describe('parseComposeLsRows', () => {
  it('reads name and status of each project', () => {
    const out = JSON.stringify([
      { Name: 'emberline-abcd1234', Status: 'running(2)', ConfigFiles: '/w/compose.yaml' },
      { Name: 'other', Status: 'exited(1)', ConfigFiles: '' },
    ]);
    expect(parseComposeLsRows(out)).toEqual({
      ok: true,
      value: [
        { name: 'emberline-abcd1234', status: 'running(2)' },
        { name: 'other', status: 'exited(1)' },
      ],
    });
  });
  it('empty output is no project; garbage is an error, not an exception', () => {
    expect(parseComposeLsRows('')).toEqual({ ok: true, value: [] });
    expect(parseComposeLsRows('[]\n')).toEqual({ ok: true, value: [] });
    expect(parseComposeLsRows('not json')).toMatchObject({
      ok: false,
      error: expect.stringContaining('compose ls'),
    });
    expect(parseComposeLsRows('{"Name":"x"}')).toMatchObject({ ok: false });
    // Rows without a name are dropped; a status that is not a string is null.
    expect(
      parseComposeLsRows('[{"Status":"running(1)"},{"Name":"emberline-abcd1234","Status":3},null]'),
    ).toEqual({
      ok: true,
      value: [{ name: 'emberline-abcd1234', status: null }],
    });
  });
});

describe('parseDockerLabels', () => {
  it('splits k=v pairs; a value holding a comma keeps it', () => {
    expect(
      parseDockerLabels(
        'com.docker.compose.project=emberline-abcd1234,com.docker.compose.config-files=/w/a.yaml,/w/b.yaml,com.docker.compose.service=web',
      ),
    ).toEqual({
      'com.docker.compose.project': 'emberline-abcd1234',
      'com.docker.compose.config-files': '/w/a.yaml,/w/b.yaml',
      'com.docker.compose.service': 'web',
    });
    expect(parseDockerLabels('')).toEqual({});
  });
});

describe('parseHostPorts', () => {
  it('unique published host ports; unpublished container ports are none', () => {
    expect(parseHostPorts('0.0.0.0:4326->80/tcp, [::]:4326->80/tcp')).toEqual([4326]);
    expect(parseHostPorts('0.0.0.0:5432->5432/tcp, 0.0.0.0:8080->80/tcp, 9000/tcp')).toEqual([5432, 8080]);
    expect(parseHostPorts('0.0.0.0:8000-8002->8000-8002/tcp')).toEqual([8000, 8001, 8002]);
    expect(parseHostPorts('80/tcp')).toEqual([]);
    expect(parseHostPorts('')).toEqual([]);
  });
});

const psLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ID: 'c0ffee',
    Names: 'emberline-abcd1234-web-1',
    Image: 'nginx:1.29.3-alpine',
    State: 'running',
    Status: 'Up 2 hours',
    Ports: '0.0.0.0:4326->80/tcp, [::]:4326->80/tcp',
    Labels: 'com.docker.compose.project=emberline-abcd1234,com.docker.compose.service=web',
    CreatedAt: '2026-10-18 08:00:00 +0000 UTC',
    RunningFor: '2 hours ago',
    ...over,
  });

describe('parseDockerPs', () => {
  it('reads each container with its compose project, service, state, ports and times', () => {
    expect(parseDockerPs(`${psLine()}\n`)).toEqual({
      ok: true,
      value: [
        {
          project: 'emberline-abcd1234',
          name: 'emberline-abcd1234-web-1',
          service: 'web',
          state: 'running',
          status: 'Up 2 hours',
          ports: [4326],
          image: 'nginx:1.29.3-alpine',
          createdAt: '2026-10-18 08:00:00 +0000 UTC',
          runningFor: '2 hours ago',
        },
      ],
    });
  });
  it('an unknown state is `unknown`; control characters are stripped', () => {
    const parsed = parseDockerPs(psLine({ State: 'removing', Status: 'Removal\u001b[31m in progress' }));
    expect(parsed).toMatchObject({
      ok: true,
      value: [{ state: 'unknown', status: 'Removal[31m in progress' }],
    });
  });
  it('skips garbage lines and lines without a project label; all garbage is an error', () => {
    const parsed = parseDockerPs(
      [
        'garbage',
        psLine({ Labels: 'com.docker.compose.service=web' }),
        psLine({ Names: 'emberline-abcd1234-db-1' }),
      ].join('\n'),
    );
    expect(parsed).toMatchObject({ ok: true, value: [{ name: 'emberline-abcd1234-db-1', service: 'web' }] });
    expect(parseDockerPs('')).toEqual({ ok: true, value: [] });
    expect(parseDockerPs('{oops\n<html>')).toMatchObject({
      ok: false,
      error: expect.stringContaining('docker ps'),
    });
  });
});

describe('parseSystemDf', () => {
  it('keeps the values as Docker prints them', () => {
    const out = [
      { Active: '2', Reclaimable: '1.2GB (50%)', Size: '2.4GB', TotalCount: '5', Type: 'Images' },
      { Active: '1', Reclaimable: '0B (0%)', Size: '12kB', TotalCount: 3, Type: 'Containers' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    expect(parseSystemDf(out)).toEqual({
      ok: true,
      value: [
        { type: 'Images', total: '5', active: '2', size: '2.4GB', reclaimable: '1.2GB (50%)' },
        { type: 'Containers', total: '3', active: '1', size: '12kB', reclaimable: '0B (0%)' },
      ],
    });
  });
  it('garbage is an error', () => {
    expect(parseSystemDf('nope')).toMatchObject({ ok: false, error: expect.stringContaining('system df') });
    expect(parseSystemDf('')).toEqual({ ok: true, value: [] });
  });
});

const run = (over: Partial<OwnershipRun> & { id: string }): OwnershipRun => ({
  projectId: 'p0000000-0000-0000-0000-000000000000',
  ticketId: null,
  ticketKey: null,
  ticketTitle: null,
  title: null,
  state: 'working',
  worktreePath: `/w/.worktrees/shop/${over.id.slice(0, 8)}`,
  createdAt: 1,
  endedAt: null,
  cancelledAt: null,
  worktreeExists: true,
  ...over,
});

describe('ownership', () => {
  const projectId = 'p0000000-0000-0000-0000-000000000000';
  const projects = [{ id: projectId, name: 'Shop' }];

  it('an agent project: the live run; a handoff successor in the same worktree owns it after the first run ended', () => {
    const first = run({
      id: 'aaaaaaaa-0000-0000-0000-000000000000',
      state: 'done',
      endedAt: 5,
      ticketId: 't1',
      ticketKey: 'SHOP-1',
      ticketTitle: 'Login',
    });
    const successor = run({
      id: 'bbbbbbbb-0000-0000-0000-000000000000',
      worktreePath: first.worktreePath,
      createdAt: 10,
      ticketId: 't1',
      ticketKey: 'SHOP-1',
      ticketTitle: 'Login',
    });
    const facts: OwnershipFacts = { runs: [first, successor], projects };
    const name = composeProjectName(first.id, first.worktreePath);
    expect(name).toBe('emberline-aaaaaaaa');
    expect(resolveDockerOwner(name, facts)).toEqual({
      kind: 'agent',
      runId: successor.id,
      runTitle: null,
      ticketId: 't1',
      ticketKey: 'SHOP-1',
      ticketTitle: 'Login',
      projectId,
      projectName: 'Shop',
      runState: 'working',
      live: true,
      inReview: false,
    });
    // The successor's own id8 is not a project of its own.
    expect(resolveDockerOwner('emberline-bbbbbbbb', facts)).toEqual({ kind: 'orphan' });
  });

  it('an ended run whose worktree is kept is in Review; without the worktree its projects are orphans', () => {
    const reviewed = run({ id: 'cccccccc-0000-0000-0000-000000000000', state: 'done', endedAt: 5 });
    const gone = run({
      id: 'dddddddd-0000-0000-0000-000000000000',
      state: 'failed',
      endedAt: 5,
      worktreeExists: false,
    });
    const facts: OwnershipFacts = { runs: [reviewed, gone], projects };
    expect(resolveDockerOwner('emberline-cccccccc-preview', facts)).toMatchObject({
      kind: 'preview',
      runId: reviewed.id,
      live: false,
      inReview: true,
    });
    expect(resolveDockerOwner('emberline-cccccccc', facts)).toMatchObject({
      kind: 'agent',
      runId: reviewed.id,
      inReview: true,
    });
    expect(resolveDockerOwner('emberline-dddddddd', facts)).toEqual({ kind: 'orphan' });
    expect(resolveDockerOwner('emberline-dddddddd-preview', facts)).toEqual({ kind: 'orphan' });
  });

  it('a rate-limited run waiting for its window is live; a cancelled one is not', () => {
    const waiting = run({
      id: 'eeeeeeee-0000-0000-0000-000000000000',
      state: 'rate_limited',
      endedAt: 5,
      worktreeExists: false,
    });
    const cancelled = run({
      id: 'ffffffff-0000-0000-0000-000000000000',
      state: 'rate_limited',
      endedAt: 5,
      cancelledAt: 5,
      worktreeExists: false,
    });
    const facts: OwnershipFacts = { runs: [waiting, cancelled], projects };
    expect(resolveDockerOwner('emberline-eeeeeeee', facts)).toMatchObject({
      kind: 'agent',
      live: true,
      inReview: false,
    });
    expect(resolveDockerOwner('emberline-ffffffff', facts)).toEqual({ kind: 'orphan' });
  });

  it("Build & Verify's main project belongs to its project; a deleted project's is an orphan", () => {
    const facts: OwnershipFacts = { runs: [], projects };
    expect(resolveDockerOwner(mainComposeProjectName(projectId), facts)).toEqual({
      kind: 'main',
      projectId,
      projectName: 'Shop',
    });
    expect(resolveDockerOwner('emberline-main-12345678', facts)).toEqual({ kind: 'orphan' });
  });

  it("main's container preview belongs to its project as a preview (kept while the project exists); a deleted project's is an orphan", () => {
    const facts: OwnershipFacts = { runs: [], projects };
    expect(resolveDockerOwner(mainPreviewComposeProjectName(projectId), facts)).toEqual({
      kind: 'main',
      projectId,
      projectName: 'Shop',
      preview: true,
    });
    expect(composeProjectsInUse(facts).has(mainPreviewComposeProjectName(projectId))).toBe(true);
    expect(resolveDockerOwner('emberline-main-12345678-preview', facts)).toEqual({ kind: 'orphan' });
    expect(composeProjectsInUse(facts).has('emberline-main-12345678-preview')).toBe(false);
  });

  it('orphans are exactly the projects the sweep would remove', () => {
    const runs = [
      run({ id: 'aaaaaaaa-0000-0000-0000-000000000000' }),
      run({ id: 'bbbbbbbb-0000-0000-0000-000000000000', state: 'done', endedAt: 5 }),
      run({ id: 'cccccccc-0000-0000-0000-000000000000', state: 'done', endedAt: 5, worktreeExists: false }),
      run({
        id: 'dddddddd-0000-0000-0000-000000000000',
        worktreePath: '/w/.worktrees/shop/aaaaaaaa',
        createdAt: 9,
      }),
    ];
    const facts: OwnershipFacts = { runs, projects };
    const names = [
      ...runs.flatMap((r) => [composeProjectName(r.id, r.worktreePath), previewComposeProjectName(r.id)]),
      mainComposeProjectName(projectId),
      mainPreviewComposeProjectName(projectId),
      'emberline-main-99999999',
      'emberline-main-99999999-preview',
      'emberline-12345678',
      'emberline-12345678-preview',
    ];
    const inUse = composeProjectsInUse(facts);
    for (const name of names) {
      expect(resolveDockerOwner(name, facts).kind === 'orphan', name).toBe(!inUse.has(name));
    }
  });
});

describe('buildDockerProjects', () => {
  const facts: OwnershipFacts = { runs: [], projects: [] };
  it('lists only Emberline projects, from `compose ls` and from containers, with their containers', () => {
    const ps = parseDockerPs(
      [
        psLine(),
        psLine({
          Names: 'emberline-abcd1234-db-1',
          Labels: 'com.docker.compose.project=emberline-abcd1234,com.docker.compose.service=db',
          Ports: '',
        }),
        psLine({
          Names: 'emberline-verify-docker-core-1',
          Labels: 'com.docker.compose.project=emberline-verify-docker,com.docker.compose.service=core',
        }),
        psLine({
          Names: 'x-1',
          Labels: 'com.docker.compose.project=emberline-1234abcd-preview,com.docker.compose.service=web',
        }),
      ].join('\n'),
    );
    const ls = parseComposeLsRows(
      JSON.stringify([
        { Name: 'emberline-abcd1234', Status: 'running(2)' },
        { Name: 'emberline', Status: 'running(2)' },
        { Name: 'emberline-verify-docker', Status: 'running(3)' },
        { Name: 'emberline-main-0000aaaa', Status: 'exited(1)' },
      ]),
    );
    const out = buildDockerProjects({ ls, ps, facts });
    expect(out.projects.map((p) => [p.name, p.status, p.containers.map((c) => c.service), p.stale])).toEqual([
      ['emberline-1234abcd-preview', null, ['web'], true],
      ['emberline-abcd1234', 'running(2)', ['db', 'web'], true],
      ['emberline-main-0000aaaa', 'exited(1)', [], true],
    ]);
    expect(out.projectsError).toBeUndefined();
    expect(out.containersError).toBeUndefined();
  });
  it('a failed part carries its error; the other part still lists', () => {
    const out = buildDockerProjects({
      ls: { ok: false, error: 'docker compose ls failed (exit 1)' },
      ps: parseDockerPs(psLine()),
      facts,
    });
    expect(out.projectsError).toBe('docker compose ls failed (exit 1)');
    expect(out.projects.map((p) => p.name)).toEqual(['emberline-abcd1234']);
    const noPs = buildDockerProjects({
      ls: parseComposeLsRows('[{"Name":"emberline-abcd1234"}]'),
      ps: { ok: false, error: 'bad' },
      facts,
    });
    expect(noPs).toMatchObject({
      containersError: 'bad',
      projects: [{ name: 'emberline-abcd1234', containers: [] }],
    });
  });
});
