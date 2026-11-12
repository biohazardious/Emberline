import { type FactorySettings, type Run, WORKTREE_YML_INVALID, worktreeCheckOf } from '@emberline/protocol';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readWizardTickets } from '../db/project-settings.js';
import { runEvents } from '../db/schema.js';
import { conflict } from '../errors.js';
import type { HealGate } from '../factory/conflict-heal.js';
import {
  auditWorktreeSlop,
  buildWorkspaceDemo,
  hasVerifiableBuildTarget,
  runCrossProviderCritic,
} from '../factory/service.js';
import { openBlockingCount } from '../review/blocking.js';
import { approvedChecks, approvedSetup, setupFinishedIn } from '../worktree-config/load.js';
import { runWorktreeYmlProblems, worktreeCommandsMissing } from '../worktree-config/trust.js';
import { isAutoFixHold } from './hold-outcome.js';
import { WORKTREE_COMMANDS_PROMPT, worktreeYmlFixPrompt } from './recovery.js';

/** The checks behind a `build_gate_failed` hold. */
export type FixCheck = 'worktree_yml' | 'worktree_commands' | 'build';

/** Hold payload text kept for the recovery prompts: at most this many characters. */
const HOLD_PAYLOAD_MAX = 4_000;
export const holdText = (text: string): string => text.slice(0, HOLD_PAYLOAD_MAX);

/** What the build gate asks the agent when the checks failed (`excerpt`: the end of their output). */
export const buildFixPrompt = (excerpt: string): string =>
  `[Self-Healing Build, Lint & Test Gate] Automated verification (build / lint / unit tests) failed:\n\n\`\`\`\n${excerpt}\n\`\`\`\n\nPlease fix the compiler, linter, or unit test failures above and verify all checks pass cleanly before finishing.`;

/** Which check a `build_gate_failed` note is about: a worktree config check (worktreeCheckOf), else the build gate's. */
export const fixCheckOf = (payload: unknown): FixCheck =>
  worktreeCheckOf('build_gate_failed', payload) ?? 'build';

/** The request a `build_gate_failed` hold sends, rebuilt from its note's `output` (before 0.6.1 it was not stored). */
export function buildGateRequest(check: FixCheck, output: string): string {
  if (check === 'worktree_yml') {
    return worktreeYmlFixPrompt(output.slice(WORKTREE_YML_INVALID.length).replace(/^\n/, ''));
  }
  return check === 'worktree_commands' ? WORKTREE_COMMANDS_PROMPT : buildFixPrompt(output);
}

/** Whether a gate may still prompt the run's agent: its session is alive, or it can be resumed. */
const takesPrompt = (run: Pick<Run, 'endedAt' | 'resumable'>): boolean => !run.endedAt || run.resumable;

/**
 * One pipeline pass as the gates see it: the run under check and how to hold it. A gate notes on
 * the run, asks its agent for a fix, or hands the hold to a person; it never merges or moves the ticket.
 */
export interface GatePass {
  db: Db;
  run: Run;
  projectPath: string;
  settings: FactorySettings;
  /** The run's ticket, if it still exists. */
  ticket: { id: string; title: string; body: string } | undefined;
  /** The Factory orchestrator's own ticket: its run writes tickets, not code. */
  orchestrator: boolean;
  /** The agent worked again since this pass began: the pass of its newer turn decides. */
  stale(): boolean;
  note(type: string, payload: Record<string, unknown>): void;
  /** Holds the run for the agent's fix (noted first) and asks for it; whether the request arrived. */
  requestFix(type: string, note: Record<string, unknown>, request: string): Promise<boolean>;
  /** A hold for a person: the run's session is closed (it stays resumable) and the chain goes on. */
  closeAndGoOn(): Promise<void>;
  /** What closes a gate's request to an agent that has the completion tool. */
  completionReminder(separator: string): string;
  dockerEnv(): Promise<Record<string, string>>;
}

/**
 * A gate's verdict. `pass`: the next gate runs. `merge_blocked`: the pass goes on to its end, but
 * nothing is merged and the ticket stays in Review for a person. `halt`: the pass ends here (the
 * agent was asked for a fix, the hold is a person's, or a newer turn decides).
 */
export type GateOutcome =
  | { kind: 'pass' }
  | { kind: 'merge_blocked'; by: 'secret_guard' | 'review'; count: number }
  | { kind: 'halt' };

const PASS: GateOutcome = { kind: 'pass' };
const HALT: GateOutcome = { kind: 'halt' };

/** Whether the run was already asked to fix this check's failure (the autoFix note survives restarts). */
export function askedToFix(db: Db, runId: string, check: FixCheck): boolean {
  return db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'build_gate_failed')))
    .all()
    .some(({ payload }) => isAutoFixHold(payload) && fixCheckOf(payload) === check);
}

/**
 * Whether the critic reviews this pass: the run has no review yet, or the latest one held the run
 * (changes asked of the agent, or a hold for a person). Like a failed build, a hold is checked again
 * on the agent's next stop: a passing review lets the merge go on, changes still needed keep it held.
 */
export function criticDue(db: Db, runId: string): boolean {
  const events = db
    .select({ id: runEvents.id, type: runEvents.type, payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), inArray(runEvents.type, ['critic_reviewed', 'critic_blocked'])))
    .orderBy(asc(runEvents.id))
    .all();
  const review = events.findLast((e) => e.type === 'critic_reviewed');
  if (!review) return true;
  return events.some((e) => e.id > review.id && e.type === 'critic_blocked');
}

/** Whether the run was already asked to fix the critic's findings (the autoFix note survives restarts). */
function criticFixRequested(db: Db, runId: string): boolean {
  return db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'critic_blocked')))
    .all()
    .some(({ payload }) => isAutoFixHold(payload));
}

/** Whether the run was already asked to clean up a secret or slop finding (the autoFix note survives restarts). */
function slopFixRequested(db: Db, runId: string): boolean {
  return db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        inArray(runEvents.type, ['secret_guard_blocked', 'slop_guard_blocked']),
      ),
    )
    .all()
    .some(({ payload }) => (payload as { autoFix?: boolean } | null)?.autoFix === true);
}

/** Event types of a run, oldest first (to tell whether its worktree setup finished). */
function runEventTypes(db: Db, runId: string): string[] {
  return db
    .select({ type: runEvents.type })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.id))
    .all()
    .map((e) => e.type);
}

/**
 * A worktree config check failed: the agent is asked once to fix it (with the self-healing gate on
 * and a run that can take a prompt); after that, or otherwise, the hold is a person's.
 */
async function worktreeConfigFailed(
  pass: GatePass,
  check: 'worktree_yml' | 'worktree_commands',
  gateNote: Record<string, unknown>,
  request: string,
): Promise<GateOutcome> {
  const { db, run, settings } = pass;
  const autoFix = settings.selfHealingBuildGate && !askedToFix(db, run.id, check) && takesPrompt(run);
  const asked =
    autoFix &&
    (await pass.requestFix('build_gate_failed', gateNote, `${request}${pass.completionReminder(' ')}`));
  if (!asked) {
    if (!autoFix) pass.note('build_gate_failed', { autoFix: false, ...gateNote });
    await pass.closeAndGoOn();
  }
  return HALT;
}

/**
 * The run's `.emberline/worktree.yml` must stay usable on main: one it added or changed that does
 * not parse would be ignored there, so it fails the gate before the merge, whatever the
 * self-healing setting and whether a build target exists. A check that could not run is not a pass.
 */
export async function worktreeYmlGate(pass: GatePass): Promise<GateOutcome> {
  const { run, projectPath } = pass;
  if (!run.worktreePath || run.worktreePath === projectPath) return PASS;
  let problems: string[] | null;
  try {
    problems = await runWorktreeYmlProblems(run.worktreePath, projectPath);
  } catch (error) {
    if (pass.stale()) return HALT;
    const message = `.emberline/worktree.yml could not be checked: ${(error as Error).message ?? ''}`;
    pass.note('build_gate_error', { message: message.slice(0, 500) });
    return HALT;
  }
  if (!problems) return PASS;
  if (pass.stale()) return HALT;
  const errorText = problems.join('\n').slice(0, 2_400);
  return worktreeConfigFailed(
    pass,
    'worktree_yml',
    { check: 'worktree_yml', output: holdText(`${WORKTREE_YML_INVALID}\n${errorText}`) },
    worktreeYmlFixPrompt(errorText),
  );
}

/**
 * An Auto Bootstrap (the wizard left the stack to the agent and generated no commands) must write
 * its worktree commands; without them the build gate would fall back to detection.
 */
export async function worktreeCommandsGate(pass: GatePass): Promise<GateOutcome> {
  const { db, run, ticket, projectPath } = pass;
  const roles = readWizardTickets(db, run.projectId);
  if (!ticket || !roles?.bootstrapWritesWorktree || ticket.id !== roles.bootstrap) return PASS;
  const missing = await worktreeCommandsMissing(run.worktreePath || projectPath).catch(() => null);
  if (!missing) return PASS;
  if (pass.stale()) return HALT;
  return worktreeConfigFailed(
    pass,
    'worktree_commands',
    { check: 'worktree_commands', output: holdText(missing) },
    WORKTREE_COMMANDS_PROMPT,
  );
}

/** A tree the build gate's checks run on: a run's worktree, or one core made itself. */
export interface BuildCheckTarget {
  db: Db;
  projectId: string;
  /** Whose build it is (a run id, or the name of core's own job). */
  targetId: string;
  workspacePath: string;
  /** The approved worktree.yml's setup already ran in this tree. */
  setupDone: boolean;
  dockerEnv(): Promise<Record<string, string>>;
  /** Runs the checks (tests inject it); default: buildWorkspaceDemo. */
  build?: typeof buildWorkspaceDemo;
}

/**
 * The build gate's checks on a tree as it is now: their result, the error that kept them from
 * running, or null when there is nothing to verify.
 */
async function runBuildChecksIn(
  target: BuildCheckTarget,
): Promise<{ ok: boolean; output: string } | Error | null> {
  const { db, projectId, workspacePath } = target;
  const checks = approvedChecks(db, projectId);
  const verifiable = Boolean(workspacePath) && (await hasVerifiableBuildTarget(workspacePath, checks));
  if (!verifiable) return null;
  return (target.build ?? buildWorkspaceDemo)({
    db,
    projectId,
    targetId: target.targetId,
    workspacePath,
    checks,
    setup: target.setupDone ? [] : approvedSetup(db, projectId),
    env: await target.dockerEnv(),
  }).catch((error: unknown) => error as Error);
}

/** The build gate's checks on the run's worktree as it is now (see runBuildChecksIn). */
function runBuildChecks(pass: Pick<GatePass, 'db' | 'run' | 'dockerEnv'>) {
  const { db, run } = pass;
  return runBuildChecksIn({
    db,
    projectId: run.projectId,
    targetId: run.id,
    workspacePath: run.worktreePath,
    // A worktree whose own setup finished is not set up twice; a skipped or failed one is.
    setupDone: setupFinishedIn(runEventTypes(db, run.id)),
    dockerEnv: () => pass.dockerEnv(),
  });
}

/**
 * The build gate's checks again, for a tree core changed itself (the conflict heal's merge of main):
 * no agent is asked. Unlike the gate, a gate that is off or a tree with nothing to verify is no pass
 * here but `unverified`: core's own union merge lands only when a real check ran on it and passed.
 */
export async function verifyBuild(
  pass: Pick<GatePass, 'db' | 'run' | 'settings' | 'dockerEnv'>,
): Promise<HealGate> {
  if (!pass.settings.selfHealingBuildGate) return GATE_OFF;
  return verdict(await runBuildChecks(pass));
}

/** {@link verifyBuild} for a tree that is no run's worktree (a pull's heal, in core's own worktree). */
export async function verifyBuildIn(
  target: BuildCheckTarget & { settings: FactorySettings },
): Promise<HealGate> {
  if (!target.settings.selfHealingBuildGate) return GATE_OFF;
  return verdict(await runBuildChecksIn(target));
}

const GATE_OFF: HealGate = { ok: 'unverified', reason: 'the build gate is off' };

function verdict(res: { ok: boolean; output: string } | Error | null): HealGate {
  if (res === null) return { ok: 'unverified', reason: 'the project has no build, lint or test checks' };
  if (!(res instanceof Error) && res.ok) return { ok: true };
  return { ok: false, output: res instanceof Error ? res.message : res.output };
}

/**
 * The self-healing build, lint and unit test gate: with the setting on and a verifiable target
 * (detected, or the approved worktree.yml's `checks`), every pass builds its own turn's tree. The
 * agent is asked once to fix a failure; when a later turn still fails, the hold is a person's.
 */
export async function buildGate(pass: GatePass): Promise<GateOutcome> {
  const { db, run, settings } = pass;
  if (!settings.selfHealingBuildGate || !takesPrompt(run)) return PASS;
  const buildRes = await runBuildChecks(pass);
  if (buildRes === null) return PASS;
  // B17: a gate that could not run is not a pass; leave the ticket for a person.
  if (buildRes instanceof Error) {
    if (pass.stale()) return HALT;
    pass.note('build_gate_error', { message: buildRes.message?.slice(0, 500) });
    return HALT;
  }
  if (buildRes.ok) return PASS;
  if (pass.stale()) return HALT;
  const errorExcerpt = buildRes.output.slice(-2_400);
  const gateNote = { output: holdText(errorExcerpt) };
  if (askedToFix(db, run.id, 'build')) {
    pass.note('build_gate_failed', { autoFix: false, ...gateNote });
    await pass.closeAndGoOn();
    return HALT;
  }
  await pass.requestFix(
    'build_gate_failed',
    gateNote,
    `${buildFixPrompt(errorExcerpt)}${pass.completionReminder(' ')}`,
  );
  return HALT;
}

/**
 * The deterministic secret guard and anti-slop gate over the run's diff: leaked keys and `.env`
 * files, type evasion, unfinished stubs, skipped tests, debug leftovers. The agent is asked once to
 * clean up (held first, so an undelivered request never lets a later dispatch merge the leak); a
 * secret it was already asked about blocks the merge for a person.
 */
export async function slopGate(pass: GatePass): Promise<GateOutcome> {
  const { db, run, settings } = pass;
  if (!run.worktreePath || pass.orchestrator) return PASS;
  const slopReport = await auditWorktreeSlop({ runId: run.id, workspacePath: run.worktreePath }).catch(
    () => null,
  );
  const hasSecretViolation = Boolean(settings.secretGuardGate && slopReport && !slopReport.secretGuardPassed);
  const hasSlopViolation = Boolean(
    settings.antiSlopGate && slopReport && slopReport.addedLinesAudited > 0 && !slopReport.passed,
  );
  const autoFixPrompt = slopReport?.autoFixPrompt;
  const autoFix = Boolean(
    (hasSecretViolation || hasSlopViolation) &&
    autoFixPrompt &&
    !slopFixRequested(db, run.id) &&
    takesPrompt(run),
  );
  const fixNote = autoFixPrompt ? { autoFixPrompt: holdText(autoFixPrompt) } : {};
  const secretNote = { secretLeakCount: slopReport?.secretLeakCount ?? 0, ...fixNote };
  if ((hasSecretViolation || autoFix) && pass.stale()) return HALT;
  if (autoFix && autoFixPrompt) {
    const request = `${autoFixPrompt}${pass.completionReminder('\n\n')}`;
    if (hasSecretViolation) await pass.requestFix('secret_guard_blocked', secretNote, request);
    else await pass.requestFix('slop_guard_blocked', fixNote, request);
    return HALT;
  }
  if (!hasSecretViolation) return PASS;
  pass.note('secret_guard_blocked', { ...secretNote, autoFix: false });
  return { kind: 'merge_blocked', by: 'secret_guard', count: secretNote.secretLeakCount };
}

/**
 * The cross-provider critic: once per run, and again for the turn after its request for changes,
 * so the agent's fix is reviewed too. Changes asked for again are a person's to look at.
 */
export async function criticGate(pass: GatePass): Promise<GateOutcome> {
  const { db, run, settings, ticket } = pass;
  if (!settings.crossProviderCritic || !run.worktreePath || pass.orchestrator || !criticDue(db, run.id)) {
    return PASS;
  }
  const criticRes = await runCrossProviderCritic({
    run,
    ticketTitle: ticket?.title ?? run.title,
    ticketBody: ticket?.body ?? null,
    workspacePath: run.worktreePath,
    settings,
  }).catch(() => null);
  // The agent worked again meanwhile: the pass of its newer turn asks the critic about that tree.
  if (pass.stale()) return HALT;
  // Noted once its verdict is in, so a pass a restart cut off while the critic ran asks it again
  // instead of merging without one.
  pass.note('critic_reviewed', { verdict: criticRes?.verdict ?? null });
  if (!criticRes || criticRes.verdict !== 'NEEDS_FIX' || !criticRes.followUpPrompt) return PASS;
  const criticNote = { followUpPrompt: holdText(criticRes.followUpPrompt) };
  if (criticFixRequested(db, run.id) || !takesPrompt(run)) {
    pass.note('critic_blocked', { autoFix: false, ...criticNote });
    await pass.closeAndGoOn();
    return HALT;
  }
  await pass.requestFix(
    'critic_blocked',
    criticNote,
    `${criticRes.followUpPrompt}${pass.completionReminder('\n\n')}`,
  );
  return HALT;
}

/**
 * Open blocking review feedback keeps the merge gate closed: the ticket stays in Review and the
 * person decides (resolve it, or merge anyway); the agent is not prompted.
 */
export function reviewGate(pass: Pick<GatePass, 'db' | 'run' | 'note'>): GateOutcome {
  const count = openBlockingCount(pass.db, pass.run.id);
  if (count === 0) return PASS;
  pass.note('review_blocked', { count });
  return { kind: 'merge_blocked', by: 'review', count };
}

/** The pre-commit secret guard of a person's commit from the run's page: 409 naming the first leak. */
export async function assertCommitSecretFree(
  settings: Pick<FactorySettings, 'secretGuardGate'>,
  runId: string,
  worktreePath: string,
): Promise<void> {
  if (!settings.secretGuardGate || !worktreePath) return;
  const report = await auditWorktreeSlop({ runId, workspacePath: worktreePath }).catch(() => null);
  if (!report || report.secretGuardPassed) return;
  const first = report.issues.find((i) => i.category === 'secret_leak');
  throw conflict(
    `Pre-Commit Secret Guard blocked commit (${report.secretLeakCount} secret leak(s) detected)${
      first ? ` — ${first.file}:${first.line}: ${first.message}` : ''
    }`,
  );
}
