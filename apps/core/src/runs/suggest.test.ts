import { afterEach, describe, expect, it } from 'vitest';
import { localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { buildSuggestPrompt, runSuggestion } from './suggest.js';

afterEach(() => setCommandExecutor(localCommandExecutor));
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
});

describe('runSuggestion', () => {
  it('reads structured_output.answer', async () => {
    setCommandExecutor(ok(JSON.stringify({ structured_output: { answer: 'Use GitHub.' } })));
    await expect(runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' })).resolves.toBe(
      'Use GitHub.',
    );
  });
  it('passes plan mode, the model and no session persistence', async () => {
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
    await runSuggestion({ command: 'claude', model: 'haiku', cwd: '/w', prompt: 'p' });
    expect(args).toEqual(
      expect.arrayContaining(['-p', 'p', '--permission-mode', 'plan', '--no-session-persistence', '--model']),
    );
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
});
