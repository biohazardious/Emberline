/**
 * The generic wrapper for CLIs without Claude Code's hooks (docs/DESIGN.md §3.3): a `sh -c` script
 * that runs the CLI once and reports its lifecycle through `emberline-hook`, so core tracks
 * `working` -> `done` / `failed` / `rate_limited` the same way for every CLI.
 */
import type { LaunchSpec } from './index.js';

export interface WrappedCliOptions {
  /** Agent id: names the CLI in hook payloads and selects its `emberline-cli-seed` entries. */
  agent: string;
  runId: string;
  hookToken: string;
  coreUrl: string;
  hookCommand?: string;
  prompt?: string;
  /** The CLI's command line; it reads the task from `"$EMBERLINE_PROMPT"`. */
  command: string;
  autoApprove: boolean;
  /**
   * Shell run after a prompted CLI exits, with `$STATUS` set and the CLI's output in `logFile`; it may
   * change `STATUS` (a CLI that exits 0 on a failed sign-in).
   */
  statusCheck?: (logFile: string) => string;
  /**
   * Shell whose last output line (e.g. the session transcript's latest rate-limit record) travels,
   * base64-encoded, in the failure hook's `transcript_tail` field: the transcript signal for CLIs
   * whose transcripts core cannot read. It runs in the run's directory with `$RUN_STARTED` naming a
   * file touched just before the CLI started (`find -newer "$RUN_STARTED"`), so it can keep to the
   * run's own session instead of whatever another run on the runner wrote last.
   */
  transcriptProbe?: string;
  /** Provider credentials and settings for the run; merged first. */
  extraEnv?: Record<string, string>;
  /** The adapter's own environment (first-run answers); merged last. */
  env?: Record<string, string>;
}

/** Upper bound of the transcript excerpt carried by a failure hook, in bytes before encoding. */
export const TRANSCRIPT_TAIL_BYTES = 4000;

export function buildWrappedCliLaunchSpec(options: WrappedCliOptions): LaunchSpec {
  const hook = options.hookCommand ?? 'emberline-hook';
  const { agent, prompt } = options;

  const watcherSnippet = prompt
    ? `( LAST_GIT=""; while sleep 2; do CUR_GIT=$(git status --porcelain 2>/dev/null | head -n 5 | tr '\\n' ' ' | sed 's/["\\\\]/ /g'); if [ -n "$CUR_GIT" ] && [ "$CUR_GIT" != "$LAST_GIT" ]; then LAST_GIT="$CUR_GIT"; echo "{\\"tool_name\\":\\"Edit\\",\\"message\\":\\"Worktree updated: $CUR_GIT\\"}" | ${hook} PreToolUse >/dev/null 2>&1 || true; echo "{\\"tool_name\\":\\"Edit\\",\\"message\\":\\"Worktree updated: $CUR_GIT\\"}" | ${hook} PostToolUse >/dev/null 2>&1 || true; fi; done ) & EMBERLINE_WATCH_PID=$!`
    : '';

  const logFile = `/tmp/emberline-cli-${options.runId}.log`;
  const statusFile = `/tmp/emberline-cli-${options.runId}.status`;
  const statusCheck = prompt && options.statusCheck ? `; ${options.statusCheck(logFile)}` : '';
  const wrappedExec = prompt
    ? `rm -f "${logFile}" "${statusFile}"; { { ${options.command}; echo $? > "${statusFile}"; } 2>&1 | tee "${logFile}"; }; STATUS=$(cat "${statusFile}" 2>/dev/null || echo 1); rm -f "${statusFile}"${statusCheck}`
    : `${options.command}; STATUS=$?`;

  // base64 output is JSON-safe, so the excerpt needs none of the quoting the error detail gets.
  const transcript = options.transcriptProbe
    ? `TRANSCRIPT_TAIL=$( { ${options.transcriptProbe}; } 2>/dev/null | tail -n 1 | head -c ${TRANSCRIPT_TAIL_BYTES} | base64 | tr -d '\\n'); `
    : '';
  const transcriptField = options.transcriptProbe ? `,\\"transcript_tail\\":\\"$TRANSCRIPT_TAIL\\"` : '';
  const runStarted = `/tmp/emberline-cli-${options.runId}.started`;

  const script = [
    // Merges the per-CLI config entries that pre-answer first-run questions (never blocks the run).
    `emberline-cli-seed.mjs ${agent} >/dev/null 2>&1 || true`,
    `echo '{"session_id":"'${agent}-${options.runId.slice(0, 8)}'"}' | ${hook} SessionStart >/dev/null 2>&1 || true`,
    prompt ? `echo '{"prompt":"started"}' | ${hook} UserPromptSubmit >/dev/null 2>&1 || true` : '',
    prompt
      ? `echo '{"tool_name":"${agent}","message":"Executing ${agent} CLI task"}' | ${hook} PreToolUse >/dev/null 2>&1 || true`
      : '',
    watcherSnippet,
    options.transcriptProbe ? `RUN_STARTED="${runStarted}"; : > "$RUN_STARTED"` : '',
    wrappedExec,
    prompt ? `kill "$EMBERLINE_WATCH_PID" >/dev/null 2>&1 || true` : '',
    // On failure the hook gets the end of the output: the error (e.g. a quota message with its reset
    // time) is the last line, after whatever the CLI printed while it worked.
    `if [ "$STATUS" -eq 0 ]; then rm -f "${logFile}"; echo '{"tool_name":"${agent}","message":"Completed ${agent} CLI task"}' | ${hook} PostToolUse >/dev/null 2>&1 || true; echo '{}' | ${hook} Stop >/dev/null 2>&1 || true; else ERR_DETAIL=$(sed 's/\\x1b\\[[0-9;?]*[a-zA-Z]//g' "${logFile}" 2>/dev/null | tr '\\r' '\\n' | sed '/^[[:space:]]*$/d' | tail -n 6 | tr '\\n' ' ' | sed 's/["\\\\]/ /g' | tail -c 420); rm -f "${logFile}"; if [ -z "$ERR_DETAIL" ]; then ERR_DETAIL="${agent} exited with code $STATUS"; fi; ${transcript}printf "\\n\\033[1;31m=== ❌ ${agent} exited with code %s ===\\033[0m\\n%s\\n" "$STATUS" "$ERR_DETAIL"; echo "{\\"error\\":\\"cli_exit\\",\\"reason\\":\\"$ERR_DETAIL\\",\\"message\\":\\"$ERR_DETAIL\\"${transcriptField}}" | ${hook} StopFailure >/dev/null 2>&1 || true; sleep 4; fi`,
    options.transcriptProbe ? `rm -f "$RUN_STARTED"` : '',
    `exit $STATUS`,
  ]
    .filter(Boolean)
    .join('; ');

  return {
    file: 'sh',
    args: ['-c', script],
    env: {
      ...options.extraEnv,
      EMBERLINE_RUN_ID: options.runId,
      EMBERLINE_HOOK_TOKEN: options.hookToken,
      EMBERLINE_CORE_URL: options.coreUrl,
      EMBERLINE_PROMPT: prompt ?? '',
      // Read by the runner's CLI wrappers (e.g. `agy`) to decide whether to skip approval prompts.
      EMBERLINE_AUTO_APPROVE: options.autoApprove ? '1' : '0',
      ...options.env,
    },
  };
}

/** The `transcript_tail` a wrapper failure hook carries, decoded; empty when there is none. */
export function transcriptTail(payload: Readonly<Record<string, unknown>>): string {
  const encoded = typeof payload.transcript_tail === 'string' ? payload.transcript_tail.trim() : '';
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return '';
  try {
    const binary = atob(encoded);
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}
