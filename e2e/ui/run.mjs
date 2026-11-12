#!/usr/bin/env node
/**
 * Ticket-to-merge regression suite (make e2e): Playwright drives the real web UI against the isolated
 * core + runner stack, with the fake forge (e2e/fake-forge.mjs) as the remote and e2e/fake-claude.mjs as
 * the agent. Scenarios run in order and share one project: import it, run tickets through every
 * state a person sees, and merge into main. Usage: node e2e/ui/run.mjs http://core:7420
 */
import assert from 'node:assert/strict';
import {
  api,
  ensureForgeAccount,
  hasClass,
  mainFile,
  scenario,
  seedForgeRepo,
  signInApi,
  until,
} from './lib.mjs';

const REPO = `ui-app-${Date.now().toString(36)}`;
let project;

/** Creates a ticket in Backlog through the board's form and returns its card locator and key. */
async function addTicket(page, title) {
  await page.goto(`${new URL(page.url()).origin}/projects/${project.id}/board`);
  await page.locator('#ticket-title').fill(title);
  await page.locator('#ticket-add').click();
  const card = page.getByRole('listitem', { name: new RegExp(title.replace(/[[\]]/g, '\\$&')) });
  await card.waitFor();
  return card;
}

const ticketByTitle = async (title) =>
  (await api('GET', `/api/projects/${project.id}/tickets`)).json.find((t) => t.title === title);
const latestRun = async (ticketId) =>
  (await api('GET', '/api/runs')).json.find((r) => r.ticketId === ticketId);

/** Opens the ticket's drawer and starts its run. */
async function startTicket(page, card) {
  await card.click();
  await page
    .getByRole('button', { name: /^Start/ })
    .first()
    .click();
  const confirm = page.getByRole('button', { name: /^Start anyway|^Confirm/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

const origin = (page) => new URL(page.url()).origin;

/** Waits for the ticket to reach `status`, then checks the board shows its card in that column. */
async function seeInColumn(page, title, status) {
  await until(
    async () => (await ticketByTitle(title))?.status === status,
    `${title} never reached ${status}`,
  );
  await page.goto(`${origin(page)}/projects/${project.id}/board`);
  await page.locator(`#col-${status}`).getByText(title).waitFor();
}

/** A person merges a reviewed ticket: the drawer's "Mark done" merges the run's branch into main. */
async function markDone(page, title) {
  await page.goto(`${origin(page)}/projects/${project.id}/board`);
  await page.locator(`#col-review`).getByText(title).click();
  await page.locator('#drawer-done').click();
}

await signInApi();
await ensureForgeAccount();
await seedForgeRepo(REPO, {
  'README.md': '# ui app\n',
  'package.json': '{"name":"ui-app","private":true}\n',
  Makefile: 'all:\n',
  'PROJECT.md': '# ui app\n',
});

await scenario('wizard: import a project from a git URL', async (page) => {
  await page.getByRole('button', { name: /New/ }).first().click();
  const wizard = page.getByRole('dialog');
  const footer = wizard.locator('footer');
  const next = footer.getByRole('button', { name: 'Next', exact: true });
  /** Waits until the wizard shows `name`'s step (its heading); `ms` for a step that waits on core. */
  const onStep = (name, ms) =>
    wizard.getByRole('heading', { level: 3, name, exact: true }).waitFor(ms ? { timeout: ms } : undefined);

  await onStep('Start');
  await wizard.getByLabel('Import a Git URL').check();
  await next.click();
  await onStep('Repository');
  await wizard.getByLabel('Git URL').fill(`http://forge:3000/e2e/${REPO}.git`);
  await footer.getByRole('button', { name: 'Clone', exact: true }).click();
  // The Clone step waits for core's clone and inspection and moves on to Stack by itself (it may be
  // past Clone before a check could see it, so only its end is awaited).
  await onStep('Stack', 90_000);
  await next.click();
  await onStep('Factory');
  // An import starts nothing unless asked to.
  assert.equal(await wizard.getByLabel('Import only').isChecked(), true, 'an import defaults to Import only');
  await next.click();
  await onStep('Summary');
  await footer.getByRole('button', { name: 'Finish import', exact: true }).click();
  await until(async () => {
    const list = (await api('GET', '/api/projects')).json;
    project = (Array.isArray(list) ? list : list.projects).find((p) => p.name.toLowerCase().includes(REPO));
    return project;
  }, 'the imported project never appeared');
  assert.equal(project.importSource, 'url', 'the project records that it was imported from a git URL');
  assert.match(
    (await mainFile(project.id, 'README.md')) ?? '',
    /ui app/,
    'the clone holds the repository files',
  );
});

await scenario('ticket: the card follows the agent from Backlog to Done', async (page) => {
  const title = 'Follow the agent [e2e:work]';
  const card = await addTicket(page, title);
  await page.locator('#col-backlog').getByText(title).waitFor();
  await startTicket(page, card);
  await hasClass(card, /card-live/);
  await page.locator('#col-in_progress').getByText(title).waitFor();
  await seeInColumn(page, title, 'review');
  await markDone(page, title);
  await until(
    async () => (await ticketByTitle(title))?.status === 'done',
    'the merged ticket never reached Done',
  );
  await page.locator('#col-done').getByText(title).waitFor();
  assert.equal(await mainFile(project.id, 'e2e-work.txt'), 'work\n');
});

await scenario('inbox: an agent asks a question and the answer reaches it', async (page) => {
  const title = 'Needs an answer [e2e:ask]';
  const card = await addTicket(page, title);
  await startTicket(page, card);
  await until(
    async () => (await latestRun((await ticketByTitle(title)).id))?.attention?.reason === 'question',
    'the run never asked',
  );
  await page.goto(`${new URL(page.url()).origin}/inbox`);
  const item = page.locator('.inbox-item[data-reason="question"]').filter({ hasText: title });
  await item.getByText('Which database should the demo use?').waitFor();
  await item.getByRole('button', { name: 'Answer' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('Use SQLite for the demo');
  await dialog
    .getByRole('button', { name: /^(Send|Answer|Send answer)/ })
    .last()
    .click();
  const run = await latestRun((await ticketByTitle(title)).id);
  await until(async () => {
    const res = await api(
      'GET',
      `/api/projects/${project.id}/files/content?path=e2e-ask-answered.txt&targetId=${run.id}`,
    );
    return res.status === 200;
  }, 'the agent never used the answer');
  await seeInColumn(page, title, 'review');
  await until(
    async () => (await latestRun(run.ticketId)).attention === null,
    'the answered run still needs a person',
  );
  await markDone(page, title);
  await until(
    async () => (await ticketByTitle(title))?.status === 'done',
    'the answered ticket never reached Done',
  );
  assert.match((await mainFile(project.id, 'e2e-ask-answered.txt')) ?? '', /Use SQLite for the demo/);
});

await scenario('review: a blocking comment closes the merge gate until it is resolved', async (page) => {
  const title = 'Gate the merge [e2e:review]';
  const card = await addTicket(page, title);
  await startTicket(page, card);
  const ticket = await until(async () => ticketByTitle(title), 'no ticket');
  const run = await until(async () => {
    const r = await latestRun(ticket.id);
    return r?.state === 'working' ? r : null;
  }, 'the run never worked');
  await until(
    async () => (await api('GET', `/api/runs/${run.id}/review/diff`)).json?.files?.length > 0,
    'no diff to review',
    30_000,
  ).catch(() => undefined);

  await page.goto(`${new URL(page.url()).origin}/runs/${run.id}/review`);
  await page.locator('.review-file-item', { hasText: 'e2e-review.txt' }).click();
  await page.getByRole('button', { name: 'Add file comment' }).click();
  await page.getByRole('radio', { name: 'Blocking' }).check();
  await page.getByLabel('Comment', { exact: true }).fill('This must change before it merges');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByText('This must change before it merges').waitFor();

  await api('PUT', `/api/projects/${project.id}/files/content`, {
    targetId: run.id,
    path: '.e2e-go',
    content: 'go\n',
  });
  await until(
    async () => (await latestRun(ticket.id))?.state === 'done',
    'the agent never finished its turn',
  );
  await page.getByRole('alert').filter({ hasText: 'merge gate stays closed' }).waitFor();
  await seeInColumn(page, title, 'review');
  assert.equal(await mainFile(project.id, 'e2e-review.txt'), null, 'nothing merged while the gate is closed');

  await markDone(page, title);
  await page.getByRole('button', { name: 'Merge anyway' }).waitFor();
  assert.equal(await mainFile(project.id, 'e2e-review.txt'), null, 'a refused merge changes nothing');

  await page.goto(`${new URL(page.url()).origin}/runs/${run.id}/review`);
  await page.getByRole('button', { name: /^Request changes/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await page.getByText('merge gate stays closed').waitFor({ state: 'hidden' });
  await markDone(page, title);
  await until(
    async () => (await ticketByTitle(title))?.status === 'done',
    'the resolved ticket never merged',
  );
  assert.equal(await mainFile(project.id, 'e2e-review.txt'), 'review\n');
});

await scenario('quota: a usage limit pauses the run and it resumes by itself', async (page) => {
  const title = 'Hit the limit [e2e:limit]';
  const card = await addTicket(page, title);
  await startTicket(page, card);
  const ticket = await until(async () => ticketByTitle(title), 'no ticket');
  const paused = await until(async () => {
    const r = await latestRun(ticket.id);
    return r?.state === 'rate_limited' ? r : null;
  }, 'the run never hit the usage limit');
  await hasClass(page.getByRole('listitem', { name: /Hit the limit/ }), /card-rate_limited/);
  const quota = (await api('GET', '/api/scheduler')).json;
  assert.ok(quota.window?.resetsAt, 'a quota window with a reset time is open');
  assert.equal(quota.window.resumedAt, null);
  await until(
    async () => (await api('GET', '/api/scheduler')).json.window === null,
    'the window never closed',
    200_000,
  );
  await seeInColumn(page, title, 'review');
  assert.equal(paused.id, (await latestRun(ticket.id)).id, 'the same run resumed');
  await markDone(page, title);
  await page.locator('#col-done').getByText(title).waitFor();
  assert.equal(await mainFile(project.id, 'e2e-limit.txt'), 'limit\n');
});

await scenario(
  'conflicts: two tickets appending to the same Makefile and PROJECT.md both land',
  async (page) => {
    const titles = ['Append lint [e2e:append:lint]', 'Append docs [e2e:append:docs]'];
    const cards = [];
    for (const title of titles) cards.push(await addTicket(page, title));
    await startTicket(page, cards[0]);
    await startTicket(page, cards[1]);
    for (const title of titles) await seeInColumn(page, title, 'review');
    for (const title of titles) {
      await markDone(page, title);
      await until(
        async () => (await ticketByTitle(title))?.status === 'done',
        `${title} never reached Done (the second merge conflicts and must self-heal)`,
      );
    }
    const makefile = (await mainFile(project.id, 'Makefile')) ?? '';
    const doc = (await mainFile(project.id, 'PROJECT.md')) ?? '';
    for (const name of ['lint', 'docs']) {
      assert.match(makefile, new RegExp(`^${name}:$`, 'm'), `Makefile keeps the ${name} target`);
      assert.match(doc, new RegExp(`^## ${name}$`, 'm'), `PROJECT.md keeps the ${name} section`);
    }
  },
);
