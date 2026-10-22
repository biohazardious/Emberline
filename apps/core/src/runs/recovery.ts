import { holdLabelOf, type RecoverySuggestion, type RunRecovery } from '@emberline/protocol';
import type { MergeProbeResult } from '../factory/merge-probe.js';
import { conflictResolutionPrompt } from '../factory/merge.js';

/** What one held run's recovery is built from; gathered by RecoveryService. */
export interface RecoveryInput {
  /** The hold note a person has to look at (currentHold). */
  hold: { type: string; payload: Record<string, unknown> | null };
  ticketKey: string | null;
  /** The branch runs merge into (the main workspace's checkout). */
  mainBranch: string;
  worktreePath: string;
  /** Fresh dry run of the run's branch against main (merge holds only); null when not probed. */
  probe: MergeProbeResult | null;
  /** Another ticket that added most of the add/add conflicts; `of` = all conflicts now. */
  superseding: { key: string; files: number; of: number; done: boolean } | null;
  /** Tickets whose commits moved main under the branch (merge holds only), newest first; empty when unknown. */
  movedBy: string[];
  /** Open blocking review comments, one line each (review holds only). */
  reviewComments: string[];
  /** Appended to every prompt: the completion reminder for an agent with the tool, else '' (it cannot signal completion). */
  completionReminder: string;
}

type Recovery = Omit<RunRecovery, 'delivery'>;

/** Prompt suggestions that are a form for the person to fill in (an empty answer), never sent as they are. */
export const NEEDS_PERSON_INPUT: ReadonlySet<string> = new Set(['answer_blockers']);

/** Files named in a why line before "and N more". */
const WHY_FILES = 3;

const suggestion = (s: Pick<RecoverySuggestion, 'id' | 'kind' | 'label'> & Partial<RecoverySuggestion>): RecoverySuggestion => ({
  detail: null,
  prompt: null,
  files: [],
  commands: [],
  ...s,
});

const text = (payload: Record<string, unknown> | null, key: string): string | null => {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const strings = (payload: Record<string, unknown> | null, key: string): string[] => {
  const value = payload?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
};

const count = (payload: Record<string, unknown> | null, key: string): number | null => {
  const value = payload?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const lastLine = (output: string): string | null =>
  output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? null;

const fileList = (files: string[]): string =>
  files.length > WHY_FILES ? `${files.slice(0, WHY_FILES).join(', ')} and ${files.length - WHY_FILES} more` : files.join(', ');

/** Ticket keys as one phrase: one, `A, B`, or `A, B and N more`. */
const movedByList = (keys: string[]): string =>
  keys.length > 2 ? `${keys.slice(0, 2).join(', ')} and ${keys.length - 2} more` : keys.join(', ');

/** A git failure as people read it: its last line, without the command line and git's `fatal:` prefix. */
const gitMessage = (error: string): string =>
  (lastLine(error) ?? error).replace(/^.*\bexited with code \d+: /, '').replace(/^(fatal|error): /, '');

/** A path as one shell word, so the command copies as is. */
const shellWord = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

function discard(ticketKey: string | null, detail?: string, label = 'Discard this work'): RecoverySuggestion {
  return suggestion({
    id: 'discard',
    kind: 'discard',
    label,
    detail: detail ?? `Move ${ticketKey ?? 'the ticket'} to Done without merging; the branch is kept until the next cleanup.`,
  });
}

const openReview = (): RecoverySuggestion =>
  suggestion({ id: 'open_review', kind: 'open_review', label: 'Open review', detail: 'Look at the changes and decide there.' });

function mergeFailed(input: RecoveryInput): { why: string; suggestions: RecoverySuggestion[] } {
  const { mainBranch, probe, ticketKey } = input;
  const main = shellWord(mainBranch);
  const manual = (files: string[]) =>
    suggestion({
      id: 'resolve_by_hand',
      kind: 'manual',
      label: 'Resolve by hand',
      detail: `Merge ${mainBranch} into the run's branch in its worktree, fix the conflicts, then commit.`,
      files,
      commands: [
        `git -C ${shellWord(input.worktreePath)} merge ${main}`,
        `git -C ${shellWord(input.worktreePath)} add -A`,
        `git -C ${shellWord(input.worktreePath)} commit --no-edit`,
      ],
    });
  const resolve = (files: string[]) =>
    suggestion({
      id: 'resolve_conflicts',
      kind: 'prompt',
      label: 'Resolve conflicts',
      detail: files.length > 0 ? `Ask the agent to merge ${mainBranch} and resolve ${plural(files.length, 'conflict', 'conflicts')}.` : `Ask the agent to merge ${mainBranch} and resolve the conflicts.`,
      prompt:
        (files.length > 0
          ? conflictResolutionPrompt(mainBranch, files)
          : `Merge ${mainBranch} into your branch (git merge ${mainBranch}), resolve every conflict keeping the intent of both changes, run the project's checks, commit, and finish.`) +
        input.completionReminder,
      files,
    });

  if (probe?.ok && probe.conflicts.length === 0) {
    return {
      why: `the branch merges cleanly into ${mainBranch} now`,
      suggestions: [
        suggestion({ id: 'merge_now', kind: 'merge', label: 'Merge now', detail: `Nothing conflicts with ${mainBranch} any more.` }),
        discard(ticketKey),
      ],
    };
  }

  if (probe?.ok) {
    const files = probe.conflicts.map((c) => c.path);
    const movers = movedByList(input.movedBy);
    const why = `${mainBranch} moved on${movers ? ` (${movers})` : ''} and ${plural(files.length, 'file now conflicts', 'files now conflict')}: ${fileList(files)}`;
    const sup = input.superseding;
    if (sup?.done && sup.files * 2 >= sup.of) {
      return {
        why,
        suggestions: [discard(ticketKey, `${sup.key} already added these files (${sup.files} of ${sup.of} conflicts).`), resolve(files), manual(files)],
      };
    }
    return { why, suggestions: [resolve(files), discard(ticketKey), manual(files)] };
  }

  // Not compared now (the probe failed, or there was nothing to probe): what the merge reported.
  const stored = strings(input.hold.payload, 'conflicts');
  const why = probe
    ? `could not compare with ${mainBranch}: ${gitMessage(probe.error)}`
    : stored.length > 0
      ? `the merge into ${mainBranch} conflicted: ${fileList(stored)}`
      : `the merge into ${mainBranch} failed`;
  return { why, suggestions: [resolve(stored), discard(ticketKey), manual(stored)] };
}

function buildGate(input: RecoveryInput, couldNotRun: boolean): { why: string; suggestions: RecoverySuggestion[] } {
  const payload = input.hold.payload;
  const output = text(payload, couldNotRun ? 'message' : 'output');
  const last = output ? lastLine(output) : null;
  const head = couldNotRun ? 'the checks could not run' : 'the checks failed';
  const prompt = couldNotRun
    ? output
      ? `The project's checks could not run on your branch (${last}). Find out why, fix it, run the checks until they pass, commit, and finish.`
      : "Run the project's checks and fix every failure, including anything that keeps them from running, then commit and finish."
    : output
      ? `The project's checks failed on your branch. Their output ended with:\n\n\`\`\`\n${output}\n\`\`\`\n\nFix every failure, run the checks again until they pass, commit, and finish.`
      : "Run the project's checks and fix every failure, then commit and finish.";
  return {
    why: last ? `${head}: ${last}` : head,
    suggestions: [
      suggestion({ id: 'fix_checks', kind: 'prompt', label: 'Fix the checks', detail: 'Ask the agent to make the checks pass.', prompt: prompt + input.completionReminder }),
      suggestion({
        id: 'run_checks',
        kind: 'manual',
        label: 'Run Build & Verify',
        detail: "Run the checks again from the run's Build & Verify panel to see the current result.",
      }),
    ],
  };
}

/** What the agent is asked when the run's `.emberline/worktree.yml` does not parse (also the automatic request's text). */
export const worktreeYmlFixPrompt = (errorText: string): string =>
  `[Worktree config check] \`.emberline/worktree.yml\` in your branch is not valid, so Emberline would ignore it:\n\n\`\`\`\n${errorText}\n\`\`\`\n\nFix it (or remove your change) so the file matches the schema, then commit before finishing.`;

/** What the agent is asked when an Auto Bootstrap left `.emberline/worktree.yml` without commands. */
export const WORKTREE_COMMANDS_PROMPT =
  '[Worktree commands] This ticket asks you to write the setup, build, lint and test commands and the preview service for the chosen stack into `.emberline/worktree.yml`, and the file still has none. Add them, make them pass, then commit before finishing.';

/** The worktree config checks hold as a `build_gate_failed` note; null for an ordinary failed build. */
function worktreeConfig(input: RecoveryInput): { why: string; suggestions: RecoverySuggestion[] } | null {
  const payload = input.hold.payload;
  const label = holdLabelOf('build_gate_failed', payload);
  const commands = label === 'Worktree commands are missing';
  if (!commands && label !== 'Worktree config is not valid') return null;
  const output = text(payload, 'output') ?? '';
  const errorText = output.replace(/^\.emberline\/worktree\.yml is not valid:\n?/, '').trim();
  const first = errorText.split('\n').map((l) => l.trim()).find(Boolean) ?? null;
  return {
    why: commands
      ? 'the bootstrap left .emberline/worktree.yml without setup, build, lint or test commands'
      : `the run's .emberline/worktree.yml is not valid${first ? `: ${first}` : ''}`,
    suggestions: [
      suggestion({
        id: 'fix_worktree_yml',
        kind: 'prompt',
        label: 'Fix the file',
        detail: commands ? 'Ask the agent to add the commands.' : 'Ask the agent to make .emberline/worktree.yml valid.',
        prompt: (commands ? WORKTREE_COMMANDS_PROMPT : worktreeYmlFixPrompt(errorText || 'The file could not be read.')) + input.completionReminder,
      }),
      openReview(),
      discard(input.ticketKey),
    ],
  };
}

function secretGuard(input: RecoveryInput): { why: string; suggestions: RecoverySuggestion[] } {
  const n = count(input.hold.payload, 'secretLeakCount');
  const found = text(input.hold.payload, 'autoFixPrompt');
  const prompt =
    `The secret guard found ${n ? plural(n, 'possible secret', 'possible secrets') : 'possible secrets'} in your branch's changes. ` +
    "Remove them from the branch history of this run, not only from the latest commit (rewrite this run's own commits if needed). " +
    'Read the values from environment variables instead, document placeholders in .env.example, and never commit a .env file. ' +
    "Run the project's checks, commit, and finish." +
    (found ? `\n\nWhat the guard found:\n\n${found}` : '');
  return {
    why: n ? `${plural(n, 'possible secret', 'possible secrets')} in the diff` : 'possible secrets in the diff',
    suggestions: [
      suggestion({ id: 'remove_secrets', kind: 'prompt', label: 'Remove the secrets', detail: 'Ask the agent to take them out of the branch.', prompt: prompt + input.completionReminder }),
      openReview(),
    ],
  };
}

function completionBlocked(input: RecoveryInput): { why: string; suggestions: RecoverySuggestion[] } {
  const blockers = strings(input.hold.payload, 'blockers');
  const quoted = blockers.length > 0 ? blockers.map((b) => b.split('\n').map((l) => `> ${l}`).join('\n')).join('\n') : '> (no details)';
  return {
    why: blockers.length > 0 ? `the agent reported blockers: ${blockers.join('; ')}` : 'the agent reported blockers',
    suggestions: [
      suggestion({
        id: 'answer_blockers',
        kind: 'prompt',
        label: 'Answer the blockers',
        detail: 'Write your answer under the quoted blockers.',
        prompt: `You reported that you are blocked:\n\n${quoted}\n\nMy answer:\n\n\n\nContinue the work with this answer, run the project's checks, commit, and finish.${input.completionReminder}`,
      }),
      discard(input.ticketKey),
    ],
  };
}

function reviewBlocked(input: RecoveryInput): { why: string; suggestions: RecoverySuggestion[] } {
  const n = count(input.hold.payload, 'count') ?? (input.reviewComments.length || null);
  const comments = input.reviewComments.map((c) => `- ${c}`).join('\n');
  const prompt = comments
    ? `These blocking review comments are open on your changes:\n\n${comments}\n\nAddress every one of them, run the project's checks, commit, and finish.`
    : "Address the open blocking review comments on your changes, run the project's checks, commit, and finish.";
  return {
    why: n ? `${plural(n, 'blocking review comment is', 'blocking review comments are')} open` : 'blocking review comments are open',
    suggestions: [
      openReview(),
      suggestion({ id: 'address_comments', kind: 'prompt', label: 'Address the comments', detail: 'Ask the agent to work through them.', prompt: prompt + input.completionReminder }),
    ],
  };
}

/** Why a run is held and at most three ways out, best first. Pure. */
export function buildRecovery(input: RecoveryInput): Recovery {
  const { type, payload } = input.hold;
  const label = holdLabelOf(type, payload);
  const done = (body: { why: string; suggestions: RecoverySuggestion[] }): Recovery => ({
    hold: type,
    label,
    why: body.why,
    suggestions: body.suggestions.slice(0, 3),
  });
  const ask = (id: string, button: string, detail: string, prompt: string) =>
    suggestion({ id, kind: 'prompt', label: button, detail, prompt: prompt + input.completionReminder });

  switch (type) {
    case 'merge_failed':
      return done(mergeFailed(input));
    case 'build_gate_failed':
      return done(worktreeConfig(input) ?? buildGate(input, false));
    case 'build_gate_error':
      return done(buildGate(input, true));
    case 'critic_blocked':
      return done({
        why: 'the code audit asked for changes',
        suggestions: [
          ask(
            'apply_audit',
            "Apply the audit's request",
            'Ask the agent to address what the code audit found.',
            text(payload, 'followUpPrompt') ?? "Address the code audit's findings on your branch, run the project's checks, commit, and finish.",
          ),
          openReview(),
        ],
      });
    case 'secret_guard_blocked':
      return done(secretGuard(input));
    case 'slop_guard_blocked':
      return done({
        why: 'the quality guard found problems',
        suggestions: [
          ask(
            'fix_quality',
            'Fix them',
            'Ask the agent to clean up what the quality guard found.',
            text(payload, 'autoFixPrompt') ??
              "Fix the problems the quality guard found in your changes (leftover TODOs, `any` casts, skipped tests, debug output), run the project's checks, commit, and finish.",
          ),
          openReview(),
        ],
      });
    case 'completion_missing':
      return done({
        why: 'the agent stopped without reporting completion',
        suggestions: [
          ask(
            'ask_completion',
            'Ask for completion',
            'Ask the agent to report that it is done, or what blocks it.',
            'You stopped without reporting that the ticket is complete. If the work is done, call the `ticket_complete` tool with a short summary of what you changed. If something blocks you, say what blocks you.',
          ),
        ],
      });
    case 'completion_blocked':
      return done(completionBlocked(input));
    case 'review_blocked':
      return done(reviewBlocked(input));
    case 'no_changes': {
      // An agent without the completion tool (completionReminder is '') cannot register an explanation:
      // its reply is the explanation, and a person marks the ticket done.
      const canComplete = input.completionReminder !== '';
      return done({
        why: canComplete ? 'the agent ended without changing anything or saying what it did' : 'the agent ended without changing anything',
        suggestions: [
          ask(
            'do_the_ticket',
            'Do the ticket',
            'Ask the agent to do the work, or to say why none is needed.',
            "The ticket asks for changes, but you made none. Do the work it asks for, run the project's checks, commit, and finish. " +
              (canComplete
                ? 'If the ticket really needs no change, explain why nothing is needed and finish.'
                : 'If the ticket really needs no change, explain why in your reply; a person will mark the ticket done.'),
          ),
          // The person's Merge now: with nothing to merge it moves the ticket to Done.
          suggestion({
            id: 'merge_now',
            kind: 'merge',
            label: 'Mark done anyway',
            detail: `Move ${input.ticketKey ?? 'the ticket'} to Done as finished. There is nothing to merge.`,
          }),
          discard(
            input.ticketKey,
            `Move ${input.ticketKey ?? 'the ticket'} to Done as not needed. Nothing is merged, and the branch is kept until the next cleanup.`,
            'Close as not needed',
          ),
        ],
      });
    }
    default:
      return done({ why: 'the ticket is held for a person', suggestions: [openReview()] });
  }
}
