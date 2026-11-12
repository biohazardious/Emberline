#!/usr/bin/env node
/**
 * Claude stand-in for make e2e (EMBERLINE_CLAUDE_COMMAND). It speaks the hook protocol a real run does
 * (SessionStart, UserPromptSubmit, ticket_complete, Stop, StopFailure), over HTTP with the run's token,
 * and picks its behaviour from a marker in the ticket prompt:
 *
 *   [e2e:work]    commits a file, finishes after a short while ([e2e:work:NAME]: the file e2e-work-NAME.txt)
 *   [e2e:ask]     commits a file and opens a question picker; finishes when a person answers on its terminal
 *   [e2e:review]  commits a file and waits for the file `.e2e-go` in the worktree, so a test can review first
 *   [e2e:append:NAME] appends a `NAME` target to Makefile and a `NAME` section to PROJECT.md (both files exist in main)
 *   [e2e:limit]   hits a usage limit once; after the reset it gets "Continue where you left off." and finishes
 *
 * A prompt without a marker behaves like [e2e:work]. Called with --json-schema (`claude -p … --output-format
 * json`, as the release-notes draft calls it), it prints the CLI's result envelope instead: the
 * release-notes answer in `structured_output`, or an error for any other schema.
 * Test-only: the runner image has no real Claude here.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One structured answer and out: no run, no hooks. */
if (process.argv.includes('--json-schema')) {
  const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1] ?? '{}');
  const notesSchema = Boolean(schema.properties?.bump && schema.properties?.notes);
  const envelope = notesSchema
    ? {
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: {
          bump: 'minor',
          notes: '### Added\n\n- A file the factory wrote on the working branch (e2e).',
        },
      }
    : {
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'fake claude answers only the release-notes schema',
      };
  console.log(JSON.stringify(envelope));
  process.exit(0);
}

const runId = process.env.EMBERLINE_RUN_ID ?? '';
const token = process.env.EMBERLINE_HOOK_TOKEN ?? '';
const core = process.env.EMBERLINE_CORE_URL ?? '';
const argv = process.argv.slice(2);
const prompt = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1).join(' ') : '';
const marker = /\[e2e:(work|ask|review|limit|append)(?::([a-z0-9-]+))?\]/.exec(prompt);
const mode = marker?.[1] ?? 'work';
const appendName = marker?.[2] ?? 'extra';
const resumed = argv.includes('--resume');
/** Survives a relaunch of this process: whether the usage limit was already hit for this run. */
const limitMarker = `/tmp/e2e-limit-${runId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(url, body) {
  const res = await fetch(`${core}${url}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
}
const hook = (event, payload = {}) =>
  post('/api/internal/hooks', { runId, event, receivedAt: new Date().toISOString(), payload });
const complete = (summary, blockers = []) =>
  post(`/api/internal/runs/${runId}/complete`, { summary, handoff: 'see the commit', blockers });

function commitFile(name, content) {
  if (content !== null) writeFileSync(name, content);
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=agent@e2e', '-c', 'user.name=e2e agent', ...args], {
      stdio: 'ignore',
    });
  git('add', name);
  git('commit', '-q', '-m', `e2e: add ${name}`);
}

/** What a person typed into this terminal: waits for input, then for a quiet moment after the last chunk. */
function nextInput() {
  return new Promise((resolve) => {
    let text = '';
    let timer;
    const onData = (chunk) => {
      text += chunk;
      clearTimeout(timer);
      timer = setTimeout(() => {
        process.stdin.off('data', onData);
        resolve(text);
      }, 1500);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

async function finish(summary, blockers = []) {
  await complete(summary, blockers);
  await hook('Stop');
}

const fileName = mode === 'work' && marker?.[2] ? `e2e-work-${marker[2]}.txt` : `e2e-${mode}.txt`;
console.log(`fake claude ready (${mode}${resumed ? ', resumed' : ''})`);

async function main() {
  if (!resumed) {
    await post(`/api/internal/runs/${runId}/completion-tool`);
    await hook('SessionStart', { session_id: `fake-${runId}` });
  }
  await hook('UserPromptSubmit');

  if (mode === 'limit' && !existsSync(limitMarker)) {
    writeFileSync(limitMarker, 'hit');
    const resetAt = Math.floor(Date.now() / 1000) + Number.parseInt(process.env.E2E_LIMIT_SECONDS ?? '5', 10);
    await hook('StopFailure', {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${resetAt}`,
    });
    while (!/continue/i.test(await nextInput())) await sleep(100);
    await hook('UserPromptSubmit');
  }

  if (mode === 'ask') {
    commitFile(fileName, 'pending an answer\n');
    await hook('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which database should the demo use?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'SQLite', description: 'one file, no server' },
              { label: 'Postgres', description: 'a server to run' },
            ],
          },
        ],
      },
    });
    await hook('Notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use AskUserQuestion',
    });
    const answer = await nextInput();
    await hook('PostToolUse', { tool_name: 'AskUserQuestion' });
    commitFile(`${path.parse(fileName).name}-answered.txt`, `${answer.replace(/\s+/g, ' ').trim()}\n`);
    await finish('Used the answer');
    return;
  }

  if (mode === 'append') {
    appendFileSync('Makefile', `\n${appendName}:\n\techo ${appendName}\n`);
    appendFileSync('PROJECT.md', `\n## ${appendName}\n\nAdded by ${appendName}.\n`);
    commitFile('Makefile', null);
    commitFile('PROJECT.md', null);
  } else {
    commitFile(fileName, `${mode}\n`);
  }
  if (mode === 'review') {
    while (!existsSync('.e2e-go')) await sleep(300);
    rmSync('.e2e-go');
  } else {
    await sleep(4000);
  }
  await finish(`Finished ${mode}`);
}

/** A finished run keeps its terminal like a real CLI: every later prompt (review feedback) is a new turn. */
async function followUps() {
  for (;;) {
    await nextInput();
    await hook('UserPromptSubmit');
    await finish('Addressed the feedback');
  }
}

await main()
  .then(followUps)
  .catch((error) => {
    console.error(`fake claude failed: ${error.message}`);
    process.exitCode = 1;
  });
