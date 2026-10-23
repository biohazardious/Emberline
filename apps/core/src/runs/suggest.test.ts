import { afterEach, describe, expect, it } from 'vitest';
import { localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { buildSuggestPrompt, runSuggestion } from './suggest.js';

afterEach(() => setCommandExecutor(localCommandExecutor));
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ok = (stdout: string) => async () =>
  ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1 }) as never;

describe('buildSuggestPrompt', () => {
  it('names the ticket, the question and the options, and forbids secrets', () => {
    const p = buildSuggestPrompt({
      ticketTitle: 'EL-1 Add login',
      ticketBody: 'x'.repeat(10_000),
      question: { kind: 'question', text: 'Which provider?', options: [{ label: 'GitHub', detail: null }] },
      lastMessage: null,
    });
    expect(p).toContain('EL-1 Add login');
    expect(p).toContain('Which provider?');
    expect(p).toContain('- GitHub');
    expect(p).toContain('Never print secrets');
    expect(p.length).toBeLessThan(20_000);
  });
  it('a blocked run quotes its blockers, not "The agent asks"', () => {
    const p = buildSuggestPrompt({
      ticketTitle: null,
      ticketBody: null,
      question: { kind: 'blocked', text: 'no API key\nno network', options: [] },
      lastMessage: null,
    });
    expect(p).toContain('The agent reported these blockers:\nno API key\nno network');
    expect(p).not.toContain('The agent asks');
  });
  it('adds the last message when it differs from the question, and leaves it out when it is the same', () => {
    const input = {
      ticketTitle: null,
      ticketBody: null,
      question: { kind: 'question' as const, text: 'Which?', options: [] },
    };
    expect(buildSuggestPrompt({ ...input, lastMessage: 'I looked at both.' })).toContain(
      "The agent's last message:\nI looked at both.",
    );
    expect(buildSuggestPrompt({ ...input, lastMessage: 'Which?' })).not.toContain('last message');
    expect(buildSuggestPrompt({ ...input, lastMessage: null })).not.toContain('last message');
  });
  it('a cut ticket description never splits an emoji', () => {
    const p = buildSuggestPrompt({
      ticketTitle: null,
      ticketBody: `${'x'.repeat(7_999)}\u{1F600}${'y'.repeat(100)}`,
      question: { kind: 'question', text: 'Which?', options: [] },
      lastMessage: null,
    });
    expect(p).toContain(`Ticket description:\n${'x'.repeat(7_999)}…`);
    expect(p).not.toMatch(loneSurrogate);
  });
});

describe('runSuggestion', () => {
  it('reads structured_output.answer', async () => {
    setCommandExecutor(ok(JSON.stringify({ structured_output: { answer: 'Use GitHub.' } })));
    await expect(runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' })).resolves.toBe(
      'Use GitHub.',
    );
  });
  it('runs the CLI with exactly these arguments', async () => {
    let seen: { file: string; args: string[]; cwd: string } | undefined;
    setCommandExecutor(async (r) => {
      seen = { file: r.file, args: r.args, cwd: r.cwd };
      return {
        exitCode: 0,
        signal: null,
        stdout: '{"structured_output":{"answer":"a"}}',
        stderr: '',
        timedOut: false,
        durationMs: 1,
      } as never;
    });
    await runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' });
    expect(seen).toEqual({
      file: 'claude',
      cwd: '/w',
      args: [
        '-p',
        'p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify({
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        }),
        '--permission-mode',
        'plan',
        '--no-session-persistence',
        '--model',
        expect.any(String),
      ],
    });
  });
  it('a prompt that starts with a dash is one argument after -p (no shell, nothing to quote)', async () => {
    let args: string[] = [];
    setCommandExecutor(async (r) => {
      args = r.args;
      return {
        exitCode: 0,
        signal: null,
        stdout: '{"structured_output":{"answer":"a"}}',
        stderr: '',
        timedOut: false,
        durationMs: 1,
      } as never;
    });
    const prompt = '--dangerously-skip-permissions; rm -rf $HOME `x`';
    await runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt });
    expect(args.slice(0, 2)).toEqual(['-p', prompt]);
    expect(args.filter((a) => a === '--dangerously-skip-permissions')).toEqual([]);
  });
  it('a timeout is 504 suggest_timeout', async () => {
    setCommandExecutor(
      async () =>
        ({
          exitCode: null,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
          timedOut: true,
          durationMs: 60_000,
        }) as never,
    );
    await expect(
      runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' }),
    ).rejects.toMatchObject({ statusCode: 504, code: 'suggest_timeout' });
  });
  it('anything else is 502 suggest_failed with the last line', async () => {
    setCommandExecutor(
      async () =>
        ({
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'boom\nInvalid API key',
          timedOut: false,
          durationMs: 1,
        }) as never,
    );
    await expect(
      runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'suggest_failed',
      message: expect.stringContaining('Invalid API key'),
    });
  });
  it('an error envelope gives its result, not the raw JSON', async () => {
    setCommandExecutor(
      ok(JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' })),
    );
    await expect(
      runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'suggest_failed',
      message: 'Claude could not suggest an answer: Claude AI usage limit reached',
    });
  });
  it('an envelope without structured_output gives its result, clipped to 200 characters', async () => {
    setCommandExecutor(ok(JSON.stringify({ type: 'result', is_error: false, result: 'x'.repeat(500) })));
    await expect(
      runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' }),
    ).rejects.toMatchObject({ message: `Claude could not suggest an answer: ${'x'.repeat(200)}…` });
  });
  it('the clipped reason never splits an emoji', async () => {
    const result = `${'x'.repeat(199)}\u{1F600}${'y'.repeat(100)}`;
    setCommandExecutor(ok(JSON.stringify({ type: 'result', is_error: true, result })));
    await expect(
      runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' }),
    ).rejects.toMatchObject({ message: `Claude could not suggest an answer: ${'x'.repeat(199)}…` });
  });
  it('an error envelope never returns an answer it carries', async () => {
    setCommandExecutor(
      ok(JSON.stringify({ is_error: true, result: 'failed', structured_output: { answer: 'half' } })),
    );
    await expect(
      runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' }),
    ).rejects.toMatchObject({ message: 'Claude could not suggest an answer: failed' });
  });
});
