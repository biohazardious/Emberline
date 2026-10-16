#!/usr/bin/env node
/**
 * Claude Code status line for Emberline runs (`statusLine` in the run's --settings).
 *
 * Claude Code pipes its status JSON to this command after each update. For subscription logins that
 * JSON carries `rate_limits` (five_hour, seven_day, spend_limit: used percentage and reset time).
 * Emberline keeps the latest copy in ~/.claude/emberline-rate-limits.json, already in the shape of
 * its usage telemetry, so the runner reads limits from the CLI itself and never handles the login
 * token. Prints a short "5h 42% · 7d 18%" line for the terminal.
 *
 * Never fails the CLI: bad input prints an empty line and exits 0. The file is replaced atomically.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** resets_at arrives as epoch seconds or an ISO string. */
function resetTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

function usageWindow(w) {
  const used = pct(w?.used_percentage);
  return used === null ? null : { utilizationPercent: used, resetsAt: resetTime(w.resets_at), severity: 'normal' };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return '';
  }
  const limits = input?.rate_limits;
  if (!limits || typeof limits !== 'object') return '';

  const fiveHour = usageWindow(limits.five_hour);
  const sevenDay = usageWindow(limits.seven_day);
  const spend = limits.spend_limit;
  const extraUsage =
    spend && typeof spend === 'object'
      ? {
          enabled: true,
          usedUsd: usd(spend.used_usd) ?? 0,
          limitUsd: usd(spend.limit_usd) ?? 0,
          utilizationPercent: pct(spend.used_percentage) ?? 0,
          disabledReason: null,
        }
      : null;
  if (!fiveHour && !sevenDay && !extraUsage) return '';

  const dir = path.join(process.env.HOME || homedir(), '.claude');
  const file = path.join(dir, 'emberline-rate-limits.json');
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), fiveHour, sevenDay, extraUsage }));
    renameSync(tmp, file);
  } catch {
    // The status line still prints; the next update tries again.
  }

  const parts = [];
  if (fiveHour) parts.push(`5h ${Math.round(fiveHour.utilizationPercent)}%`);
  if (sevenDay) parts.push(`7d ${Math.round(sevenDay.utilizationPercent)}%`);
  if (extraUsage) parts.push(`spend $${extraUsage.usedUsd.toFixed(2)}`);
  return parts.join(' · ');
}

main()
  .then((line) => process.stdout.write(`${line}\n`))
  .catch(() => process.stdout.write('\n'))
  .finally(() => process.exit(0));
