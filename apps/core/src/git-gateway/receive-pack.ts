/**
 * The only git data core reads: the pkt-line command list at the start of a receive-pack request
 * (`<old> <new> <ref>\0<caps>`, …, flush). A push through the gateway may update exactly the planned
 * ref from exactly the commit Emberline checked to exactly the planned commit; no deletes, no other or extra refs, no shallow or signed
 * pushes, and only the capabilities git itself needs (no push options, which forge hooks act on).
 * The pack after the flush is forwarded unread.
 */
import { Readable } from 'node:stream';
import { GitGatewayError } from './upstream.js';

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}
export interface PushPlan {
  ref: string;
  newOid: string;
  /**
   * What the forge's ref holds now, as Emberline read it before checking that `newOid` is a
   * fast-forward of it; the zero id (same length) for a branch the forge does not have yet. The forge
   * applies the update only if the ref still holds it, so the push can never discard commits.
   */
  oldOid: string;
}

export const MAX_COMMAND_LIST_BYTES = 64 * 1024;
const COMMAND = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/;
const refused = (message: string) => new GitGatewayError('ref_refused', message);
/** What a plain `git push` of one branch asks for; anything else (push-options above all) is refused. */
const PASSED_CAPABILITY =
  /^(report-status|report-status-v2|side-band|side-band-64k|quiet|atomic|ofs-delta|(agent|object-format|session-id)=\S*)$/;

function checkCapabilities(list: string): void {
  for (const capability of list.replace(/\n$/, '').split(' ').filter(Boolean)) {
    if (capability === 'push-options')
      throw refused('Push options are not passed on to the forge through Emberline.');
    if (!PASSED_CAPABILITY.test(capability)) {
      throw refused(
        `This push asks for a git capability Emberline does not pass on (${capability.slice(0, 40)}).`,
      );
    }
  }
}

export function parseCommandList(buf: Buffer): { commands: PushCommand[]; length: number } | null {
  const commands: PushCommand[] = [];
  let pos = 0;
  for (;;) {
    if (buf.length < pos + 4) return null;
    const hex = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw refused('The push request is not a git command list.');
    const length = Number.parseInt(hex, 16);
    if (length === 0) return { commands, length: pos + 4 };
    if (length < 5) throw refused('The push request is not a git command list.');
    if (buf.length < pos + length) return null;
    let line = buf.toString('latin1', pos + 4, pos + length);
    const nul = line.indexOf('\0');
    const capabilities = nul >= 0 ? line.slice(nul + 1) : null;
    if (nul >= 0) line = line.slice(0, nul);
    const m = COMMAND.exec(line.replace(/\n$/, ''));
    if (!m)
      throw refused('Only branch updates may be pushed through Emberline (no shallow or signed pushes).');
    if (capabilities !== null) checkCapabilities(capabilities);
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    pos += length;
  }
}

export function checkPush(commands: PushCommand[], plan: PushPlan): void {
  const [only] = commands;
  if (commands.length !== 1 || !only || only.ref !== plan.ref)
    throw refused(`This push may update only ${plan.ref}.`);
  if (/^0+$/.test(only.newOid)) throw refused('Deleting a branch is not allowed through Emberline.');
  if (only.newOid !== plan.newOid) {
    throw refused(
      `This push may set ${plan.ref} only to the commit Emberline planned (${plan.newOid.slice(0, 12)}).`,
    );
  }
  if (only.oldOid !== plan.oldOid) throw refused(oldValueRefusal(plan));
}

/** Why a push whose old value is not the planned one is refused (the remote moved, or a forged list). */
export function oldValueRefusal(plan: PushPlan): string {
  return /^0+$/.test(plan.oldOid)
    ? `This push may only create ${plan.ref}; the forge already has it.`
    : `This push may update ${plan.ref} only from the commit Emberline checked (${plan.oldOid.slice(0, 12)}).`;
}

/** git's auth probe before a large push (remote-curl's `probe_rpc`): a body that is a lone flush. */
export const PUSH_PROBE = Symbol('push probe');

/**
 * Reads the command list off a receive-pack body and checks it. Returns the whole body (unchanged)
 * as a stream, or {@link PUSH_PROBE} for a body that is only a flush (no command, nothing after it).
 * `signal` (release, a time limit) ends the wait for the command list.
 */
export async function readPushRequest(
  source: Readable,
  plan: PushPlan,
  signal?: AbortSignal,
): Promise<Readable | typeof PUSH_PROBE> {
  const it = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const late = () => refused('The push request did not send its command list in time.');
  const stopped = new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) reject(late());
    signal?.addEventListener('abort', () => reject(late()), { once: true });
  });
  stopped.catch(() => undefined);
  let head = Buffer.alloc(0);
  let ended = false;
  const more = async (): Promise<boolean> => {
    const next = await Promise.race([it.next(), stopped]);
    if (next.done) {
      ended = true;
      return false;
    }
    head = Buffer.concat([head, Buffer.from(next.value)]);
    return true;
  };
  for (;;) {
    const parsed = parseCommandList(head);
    if (parsed) {
      if (parsed.commands.length === 0) {
        while (!ended && head.length === parsed.length) await more();
        if (head.length === parsed.length) return PUSH_PROBE;
      }
      checkPush(parsed.commands, plan);
      break;
    }
    if (head.length > MAX_COMMAND_LIST_BYTES)
      throw refused('The push request has no command list Emberline can read.');
    if (!(await more())) throw refused('The push request ended before its command list did.');
  }
  const first = head;
  // Pull-based: the forge's pace still sets the client's.
  return Readable.from(
    (async function* () {
      yield first;
      if (ended) return;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield Buffer.from(next.value);
      }
    })(),
  );
}

/** Reads the command list off a receive-pack body, checks it, returns the whole body (unchanged) as a stream. */
export async function readPushCommands(source: Readable, plan: PushPlan): Promise<Readable> {
  const body = await readPushRequest(source, plan);
  if (body === PUSH_PROBE) {
    checkPush([], plan);
    throw refused('The push request has no command.');
  }
  return body;
}
