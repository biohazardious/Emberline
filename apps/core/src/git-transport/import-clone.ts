/**
 * Import clone of an http(s) repository whose host has a forge account. The token stays in core:
 * the runner's hardened git (no network, no credentials) runs `init` and `remote add`, core fetches
 * every branch and tag over its own transport, then the runner checks out the default branch.
 * Without an account the clone stays a runner PTY session (routes/projects.ts). Jobs live in memory:
 * after a restart import-status judges the folder alone, as for a forgotten clone terminal.
 */
import { mkdir } from 'node:fs/promises';
import { type GitHttpCredential, redactCredential } from '../git-credentials.js';
import { execGitFile } from '../git-exec.js';
import { realDirUnder } from '../outputs/safe-fs.js';
import { describeTransportError, fetchForClone } from './transport.js';

export interface AccountCloneStatus {
  status: 'cloning' | 'ready' | 'failed';
  tail: string;
}

interface Job {
  status: AccountCloneStatus['status'];
  lines: string[];
  controller: AbortController;
  done: Promise<void>;
}

const jobs = new Map<string, Job>();
const MAX_LINES = 40;

export function startAccountClone(input: {
  projectId: string;
  url: string;
  target: string;
  workspacesDir: string;
  credential: GitHttpCredential;
}): void {
  const job: Job = {
    status: 'cloning',
    lines: [],
    controller: new AbortController(),
    done: Promise.resolve(),
  };
  const say = (text: string) => {
    for (const line of redactCredential(text, input.credential).split(/\r?\n|\r/)) {
      if (line.trim()) job.lines.push(line.trim().slice(0, 300));
    }
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  };
  jobs.set(input.projectId, job);
  job.done = (async () => {
    try {
      // Not recursive: fails if the folder appeared since the route checked.
      await mkdir(input.target);
      if (!(await realDirUnder(input.workspacesDir, input.target)))
        throw new Error('the project folder disappeared');
      say(`Cloning ${input.url} with the forge account for ${new URL(input.url).host}…`);
      await execGitFile(['-C', input.target, 'init', '-q']);
      await execGitFile(['-C', input.target, 'remote', 'add', '--', 'origin', input.url]);
      const { defaultBranch } = await fetchForClone({
        url: input.url,
        credential: input.credential,
        workspacesDir: input.workspacesDir,
        repoRoot: input.target,
        signal: job.controller.signal,
        onMessage: say,
      });
      if (!defaultBranch) {
        job.status = 'failed';
        say('The clone has no commit (empty repository?).');
        return;
      }
      // A project removed meanwhile: no 10-minute checkout for DELETE to wait on.
      if (job.controller.signal.aborted) throw new Error('cancelled');
      say(`Checking out ${defaultBranch}…`);
      await execGitFile(
        ['-C', input.target, 'checkout', '-q', '-B', defaultBranch, '--track', `origin/${defaultBranch}`],
        { timeout: 600_000 },
      );
      job.status = 'ready';
      say('Done.');
    } catch (error) {
      job.status = 'failed';
      say(job.controller.signal.aborted ? 'Cancelled.' : describeTransportError(error, input.credential));
    }
  })();
}

export function accountCloneStatus(projectId: string): AccountCloneStatus | null {
  const job = jobs.get(projectId);
  return job ? { status: job.status, tail: job.lines.join('\n') } : null;
}

/** Project removal: stops a clone that still runs and forgets the job. */
export async function cancelAccountClone(projectId: string): Promise<void> {
  const job = jobs.get(projectId);
  if (!job) return;
  job.controller.abort();
  await job.done;
  jobs.delete(projectId);
}

/** Tests: every clone has finished. */
export async function accountClonesIdle(): Promise<void> {
  await Promise.all([...jobs.values()].map((j) => j.done));
}
