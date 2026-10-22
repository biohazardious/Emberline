import { badRequest } from '../errors.js';

/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week) evaluated in an IANA
 * time zone, with Vixie cron semantics: when both day fields are restricted a day matches if
 * EITHER matches; month and weekday names (JAN, MON-FRI) and `@daily`-style aliases are accepted.
 */
const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface CronField {
  values: Set<number>;
  /** The field starts with `*` (Vixie cron: such a day field does not restrict). */
  star: boolean;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: CronField;
  months: Set<number>;
  daysOfWeek: CronField;
}

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: { list: string[]; offset: number };
}

const PART = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i;

function parseValue(raw: string, spec: FieldSpec): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const index = spec.names?.list.indexOf(raw.toLowerCase()) ?? -1;
  if (index >= 0 && spec.names) return index + spec.names.offset;
  throw badRequest(`invalid cron ${spec.label} value "${raw}"`);
}

function parseField(field: string, spec: FieldSpec): CronField {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = PART.exec(part.trim());
    if (!match) throw badRequest(`invalid cron ${spec.label} field "${field}"`);
    const [, range, stepRaw] = match;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) throw badRequest(`invalid cron step in ${spec.label}: "${part}"`);
    let start = spec.min;
    let end = spec.max;
    if (range !== '*') {
      const [a, b] = range!.split('-');
      start = parseValue(a!, spec);
      // `5/15` means "from 5 every 15"; a plain `5` is just 5.
      end = b !== undefined ? parseValue(b, spec) : stepRaw !== undefined ? spec.max : start;
    }
    if (start < spec.min || end > spec.max || start > end) {
      throw badRequest(`cron ${spec.label} "${part}" is out of range ${spec.min}-${spec.max}`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, star: field.startsWith('*') };
}

export function parseCronExpression(expr: string): ParsedCron {
  const normalized = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) {
    throw badRequest(
      'cron expression must have 5 fields (minute hour day-of-month month day-of-week) or an alias such as @daily',
    );
  }
  const dow = parseField(fields[4]!, {
    label: 'day-of-week',
    min: 0,
    max: 7,
    names: { list: DAY_NAMES, offset: 0 },
  });
  // 7 is Sunday as well.
  if (dow.values.delete(7)) dow.values.add(0);
  return {
    minutes: parseField(fields[0]!, { label: 'minute', min: 0, max: 59 }).values,
    hours: parseField(fields[1]!, { label: 'hour', min: 0, max: 23 }).values,
    daysOfMonth: parseField(fields[2]!, { label: 'day-of-month', min: 1, max: 31 }),
    months: parseField(fields[3]!, {
      label: 'month',
      min: 1,
      max: 12,
      names: { list: MONTH_NAMES, offset: 1 },
    }).values,
    daysOfWeek: dow,
  };
}

function dayMatches(cron: ParsedCron, wall: Date): boolean {
  const dom = cron.daysOfMonth.values.has(wall.getUTCDate());
  const dow = cron.daysOfWeek.values.has(wall.getUTCDay());
  if (cron.daysOfMonth.star || cron.daysOfWeek.star) return dom && dow;
  return dom || dow;
}

/** First wall-clock minute at or after `wall` (a Date whose UTC fields hold the local time). */
function nextWallClockMatch(cron: ParsedCron, wall: Date): Date | null {
  const candidate = new Date(wall.getTime());
  for (let i = 0; i < 366 * 24 * 60 * 5; i++) {
    if (!cron.months.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(cron, candidate)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
    } else if (!cron.hours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
    } else if (!cron.minutes.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
    } else {
      return candidate;
    }
    if (candidate.getTime() - wall.getTime() > 5 * 366 * 86_400_000) return null;
  }
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws a 400 for names Intl does not know (e.g. a typo in a job's zone). */
export function assertTimeZone(timeZone: string): void {
  try {
    formatterFor(timeZone);
  } catch {
    throw badRequest(`unknown time zone "${timeZone}"`);
  }
}

/** Local wall-clock time of `instantMs` in `timeZone`, as epoch ms of the same fields in UTC. */
function wallClockMs(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/**
 * The earliest instant whose local time in `timeZone` is `wallMs`, or null when that local time
 * does not exist (skipped by a daylight-saving jump). DST shifts are far below 3 hours, so the
 * offsets on either side of the wall time cover both the normal and the ambiguous case.
 */
function wallClockToInstant(wallMs: number, timeZone: string): number | null {
  const candidates = [wallMs - 3 * 3_600_000, wallMs + 3 * 3_600_000]
    .map((probe) => wallMs - (wallClockMs(probe, timeZone) - probe))
    .filter((instant) => wallClockMs(instant, timeZone) === wallMs);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** The next time strictly after `from` (whole minutes) at which `cronExpr` fires in `timeZone`. */
export function computeNextCronDate(cronExpr: string, from: Date = new Date(), timeZone = 'UTC'): Date {
  const cron = parseCronExpression(cronExpr);
  assertTimeZone(timeZone);
  let wall = new Date(wallClockMs(from.getTime(), timeZone));
  wall.setUTCSeconds(0, 0);
  wall = new Date(wall.getTime() + 60_000);
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const match = nextWallClockMatch(cron, wall);
    if (!match) break;
    const instant = wallClockToInstant(match.getTime(), timeZone);
    if (instant !== null && instant > from.getTime()) return new Date(instant);
    wall = new Date(match.getTime() + 60_000);
  }
  throw badRequest(`cron expression "${cronExpr}" never fires`);
}

/** The next `count` fire times, for previews. */
export function previewCronRuns(
  cronExpr: string,
  timeZone: string,
  count = 5,
  from: Date = new Date(),
): Date[] {
  const runs: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    cursor = computeNextCronDate(cronExpr, cursor, timeZone);
    runs.push(cursor);
  }
  return runs;
}
