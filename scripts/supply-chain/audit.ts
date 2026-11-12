// `pnpm audit --json` against the reviewed allowlist (audit-allowlist.json), once per dependency scope.
// High and critical advisories in production dependencies (`--prod`) and critical ones in dev
// dependencies (`--dev`: the build and test tooling) block a release unless an unexpired allowlist
// entry names them.

/** Severities that block in production dependencies. */
export const BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(['high', 'critical']);

/** Severities that block in dev dependencies: they never ship, but they run in CI and on developers' machines. */
export const DEV_BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(['critical']);

export interface AuditScope {
  name: string;
  /** The `pnpm audit` flag that selects the scope. */
  flag: '--prod' | '--dev';
  severities: ReadonlySet<string>;
}

export const AUDIT_SCOPES: readonly AuditScope[] = [
  { name: 'production', flag: '--prod', severities: BLOCKING_SEVERITIES },
  { name: 'dev', flag: '--dev', severities: DEV_BLOCKING_SEVERITIES },
];

export interface Advisory {
  ghsa: string;
  module: string;
  severity: string;
  title: string;
  url: string;
  paths: string[];
}

export interface AllowlistEntry {
  id: string;
  package: string;
  reason: string;
  expires: string;
}

export interface AuditVerdict {
  blocking: Advisory[];
  allowed: Advisory[];
  expired: AllowlistEntry[];
  unused: AllowlistEntry[];
}

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(record: Json, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  return value;
}

/**
 * Parses the pnpm audit report. Anything that is not a complete report (a registry error, metadata
 * counting `severities` findings the report does not list) throws: fail closed.
 */
export function parseAuditReport(
  raw: string,
  severities: ReadonlySet<string> = BLOCKING_SEVERITIES,
): Advisory[] {
  const report: unknown = JSON.parse(raw);
  if (!isObject(report)) throw new Error('pnpm audit: the report is not a JSON object');
  if ('error' in report) throw new Error(`pnpm audit failed: ${JSON.stringify(report.error)}`);
  const { advisories, metadata } = report;
  const vulnerabilities = isObject(metadata) ? metadata.vulnerabilities : undefined;
  if (!isObject(advisories) || !isObject(vulnerabilities)) {
    throw new Error('pnpm audit: the report has no "advisories" or "metadata.vulnerabilities"');
  }
  const parsed = Object.entries(advisories).map(([key, value]): Advisory => {
    const where = `pnpm audit advisory ${key}`;
    if (!isObject(value)) throw new Error(`${where}: not an object`);
    const findings = Array.isArray(value.findings) ? value.findings : [];
    return {
      ghsa: str(value, 'github_advisory_id', where),
      module: str(value, 'module_name', where),
      severity: str(value, 'severity', where).toLowerCase(),
      title: str(value, 'title', where),
      url: typeof value.url === 'string' ? value.url : '',
      paths: findings.flatMap((finding) =>
        isObject(finding) && Array.isArray(finding.paths)
          ? finding.paths.filter((path): path is string => typeof path === 'string')
          : [],
      ),
    };
  });
  const counted = [...severities].reduce((sum, severity) => {
    const count = vulnerabilities[severity];
    return sum + (typeof count === 'number' ? count : 0);
  }, 0);
  const listed = parsed.filter((advisory) => severities.has(advisory.severity)).length;
  if (counted > 0 && listed === 0) {
    throw new Error(
      `pnpm audit: metadata counts ${counted} ${[...severities].join('/')} findings but lists no such advisory`,
    );
  }
  return parsed;
}

export function parseAllowlist(raw: string): AllowlistEntry[] {
  const file: unknown = JSON.parse(raw);
  if (!isObject(file) || !Array.isArray(file.advisories)) {
    throw new Error('audit allowlist: expected { "advisories": [...] }');
  }
  const seen = new Set<string>();
  return file.advisories.map((value: unknown, index): AllowlistEntry => {
    const where = `audit allowlist entry ${index}`;
    if (!isObject(value)) throw new Error(`${where}: not an object`);
    const entry: AllowlistEntry = {
      id: str(value, 'id', where),
      package: str(value, 'package', where),
      reason: str(value, 'reason', where),
      expires: str(value, 'expires', where),
    };
    if (!GHSA.test(entry.id)) throw new Error(`${where}: "${entry.id}" is not a GHSA id`);
    if (!ISO_DATE.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
      throw new Error(`${where}: "expires" must be a YYYY-MM-DD date`);
    }
    const key = `${entry.id} ${entry.package}`;
    if (seen.has(key)) throw new Error(`${where}: ${key} is listed twice`);
    seen.add(key);
    return entry;
  });
}

/**
 * `today` is a YYYY-MM-DD date; an entry is valid through its `expires` day. Only advisories of
 * `severities` can block.
 */
export function evaluateAudit(
  advisories: Advisory[],
  allowlist: AllowlistEntry[],
  today: string,
  severities: ReadonlySet<string> = BLOCKING_SEVERITIES,
): AuditVerdict {
  const expired = allowlist.filter((entry) => entry.expires < today);
  const active = allowlist.filter((entry) => entry.expires >= today);
  const matches = (entry: AllowlistEntry, advisory: Advisory): boolean =>
    entry.id === advisory.ghsa && entry.package === advisory.module;

  const relevant = advisories.filter((advisory) => severities.has(advisory.severity));
  const allowed = relevant.filter((advisory) => active.some((entry) => matches(entry, advisory)));
  const blocking = relevant.filter((advisory) => !allowed.includes(advisory));
  const unused = active.filter((entry) => !advisories.some((advisory) => matches(entry, advisory)));
  return { blocking, allowed, expired, unused };
}

/** An advisory with the dependency scope (`production`, `dev`) whose report listed it. */
export type ScopedAdvisory = Advisory & { scope: string };

export interface ScopedAuditVerdict {
  blocking: ScopedAdvisory[];
  allowed: ScopedAdvisory[];
  expired: AllowlistEntry[];
  unused: AllowlistEntry[];
}

/**
 * One verdict over every scope's report, with the same allowlist: an entry is unused only when it
 * matches nothing in any scope, and an expired entry is reported once.
 */
export function evaluateAuditScopes(
  reports: { scope: AuditScope; advisories: Advisory[] }[],
  allowlist: AllowlistEntry[],
  today: string,
): ScopedAuditVerdict {
  const verdicts = reports.map(({ scope, advisories }) => {
    const verdict = evaluateAudit(advisories, allowlist, today, scope.severities);
    const tag = (advisory: Advisory): ScopedAdvisory => ({ ...advisory, scope: scope.name });
    return { ...verdict, blocking: verdict.blocking.map(tag), allowed: verdict.allowed.map(tag) };
  });
  return {
    blocking: verdicts.flatMap((verdict) => verdict.blocking),
    allowed: verdicts.flatMap((verdict) => verdict.allowed),
    expired: allowlist.filter((entry) => entry.expires < today),
    unused: allowlist.filter(
      (entry) => entry.expires >= today && verdicts.every((verdict) => verdict.unused.includes(entry)),
    ),
  };
}
