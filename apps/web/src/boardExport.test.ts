// @vitest-environment happy-dom
import type { Ticket } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api';
import { boardExportUrl, downloadBoardExport, fileNameFromDisposition } from './boardExport';
import { BOARD_COLUMNS } from './components/BoardCard';
import { BoardExportMenu } from './components/BoardExportMenu';
import { cleanup, click, getButton, renderDom, waitFor } from './domRender';

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boardExportUrl', () => {
  it('omits the status filter for none or every column', () => {
    const all = ['backlog', 'ready', 'in_progress', 'review', 'done'] as const;
    expect(boardExportUrl({ projectId: 'p1', format: 'csv', statuses: [] })).toBe(
      '/api/projects/p1/tickets/export?format=csv',
    );
    expect(boardExportUrl({ projectId: 'p1', format: 'json', statuses: all })).toBe(
      '/api/projects/p1/tickets/export?format=json',
    );
  });

  it('sends picked columns in board order and encodes the project id', () => {
    expect(boardExportUrl({ projectId: 'a/b', format: 'csv', statuses: ['done', 'ready'] })).toBe(
      '/api/projects/a%2Fb/tickets/export?format=csv&status=ready%2Cdone',
    );
  });
});

describe('fileNameFromDisposition', () => {
  it('prefers the UTF-8 name, then the ASCII one, then the fallback', () => {
    expect(
      fileNameFromDisposition(`attachment; filename="a_b.csv"; filename*=UTF-8''a%C3%A9b.csv`, 'x'),
    ).toBe('aéb.csv');
    expect(fileNameFromDisposition('attachment; filename="plain.json"', 'x')).toBe('plain.json');
    expect(fileNameFromDisposition(`attachment; filename*=UTF-8''%E0%A4`, 'x')).toBe('x');
    expect(fileNameFromDisposition(null, 'tickets.csv')).toBe('tickets.csv');
  });
});

describe('downloadBoardExport', () => {
  it('downloads the body under the server file name', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('key,title\r\n', {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="emberline-demo-tickets.csv"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const name = await downloadBoardExport({ projectId: 'p1', format: 'csv', statuses: [] });
    expect(name).toBe('emberline-demo-tickets.csv');
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/tickets/export?format=csv', expect.anything());
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  it('turns a core error into an ApiRequestError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'bad_request', message: 'unknown status' }, { status: 400 })),
    );
    const error = await downloadBoardExport({ projectId: 'p1', format: 'json', statuses: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 400, code: 'bad_request', message: 'unknown status' });
  });
});

describe('BoardExportMenu', () => {
  it('opens with the requested format, toggles status columns, and downloads', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"tickets":[]}', {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="tickets.json"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const onClose = vi.fn();
    const tickets: Ticket[] = [
      {
        id: 't1',
        projectId: 'p1',
        key: 'EMB-1',
        title: 'Task 1',
        body: '',
        persona: 'coder',
        status: 'ready',
        priority: 1,
        position: 1024,
        depth: 0,
        dependsOn: [],
        blockedBy: [],
        completion: null,
        external: null,
        waitingOn: null,
        createdAt: '2026-11-12T00:00:00.000Z',
        updatedAt: '2026-11-12T00:00:00.000Z',
      },
    ];

    const { container } = await renderDom(
      createElement(BoardExportMenu, {
        projectId: 'p1',
        columns: BOARD_COLUMNS,
        tickets,
        openFormat: 'json',
        onClose,
        hideTrigger: true,
      }),
    );

    expect(container.textContent).toContain('1 tickets');
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(5);
    await click(checkboxes[0]!);

    await click(getButton('Download', container));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/tickets/export?format=json&status=ready%2Cin_progress%2Creview%2Cdone',
      expect.anything(),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});
