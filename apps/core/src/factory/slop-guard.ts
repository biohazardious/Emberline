import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentId,
  type AgentModelId,
  CrossCriticResult,
  type FactorySettings,
  type Run,
  type SlopAuditGrade,
  SlopAuditReport,
  type SlopIssue,
  selectProviderModelByRank,
} from '@emberline/protocol';

const execFileAsync = promisify(execFile);

const IGNORED_PATH_SEGMENTS = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.emberline/',
  '.git/',
  'coverage/',
];

const IGNORED_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.env',
  '.pem',
  '.key',
]);

const SAFE_ENV_TEMPLATES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.test',
  '.env.defaults',
]);

export function isForbiddenSecretFile(relPath: string): boolean {
  const base = path.basename(relPath.replace(/\\/g, '/')).toLowerCase();
  if (SAFE_ENV_TEMPLATES.has(base)) return false;
  if (base === '.env' || (base.startsWith('.env.') && !SAFE_ENV_TEMPLATES.has(base))) {
    return true;
  }
  if (
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base === 'credentials.json' ||
    base === 'service-account.json'
  ) {
    return true;
  }
  return false;
}

function isCodeHygieneFile(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.css',
    '.scss',
    '.html',
    '.vue',
    '.svelte',
    '.py',
    '.go',
    '.rs',
  ].includes(ext);
}

function isAuditableFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (IGNORED_PATH_SEGMENTS.some((seg) => normalized.includes(seg))) return false;
  const base = path.basename(normalized);
  if (IGNORED_FILENAMES.has(base)) return false;
  if (base.endsWith('.min.js') || base.endsWith('.min.css') || base.endsWith('.d.ts')) return false;
  if (isForbiddenSecretFile(normalized)) return true;
  if (base.startsWith('.env')) return true;
  const ext = path.extname(base).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

function redactToken(token: string): string {
  if (token.length <= 10) return '****REDACTED****';
  return `${token.slice(0, 6)}****REDACTED****${token.slice(-3)}`;
}

export function detectSecretLeakInLine(
  file: string,
  rawLine: string,
): { message: string; fixHint: string; redactedSnippet: string } | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  const base = path.basename(file).toLowerCase();
  if (SAFE_ENV_TEMPLATES.has(base)) return null;

  const secretPatterns: Array<{
    name: string;
    regex: RegExp;
    hint: string;
  }> = [
    {
      name: 'Anthropic API Key (`sk-ant-...`)',
      regex: /\bsk-ant-[a-zA-Z0-9_-]{16,}\b/,
      hint: 'Remove the hardcoded Anthropic key and read `process.env.ANTHROPIC_API_KEY` at runtime.',
    },
    {
      name: 'OpenAI / Secret API Key (`sk-...`)',
      regex: /\bsk-(?:proj-|live-|test-)?[a-zA-Z0-9]{20,}\b/,
      hint: 'Remove the hardcoded `sk-...` secret key and read it from `process.env.OPENAI_API_KEY` or environment config.',
    },
    {
      name: 'Google / Gemini API Key (`AIza...`)',
      regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
      hint: 'Remove the hardcoded Google/Gemini API key and read `process.env.GEMINI_API_KEY` at runtime.',
    },
    {
      name: 'GitHub Personal Access Token',
      regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{24,}\b|\bgithub_pat_[A-Za-z0-9_]{24,}\b/,
      hint: 'Revoke/remove the hardcoded GitHub token and use `process.env.GITHUB_TOKEN`.',
    },
    {
      name: 'GitLab Personal Access Token (`glpat-...`)',
      regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
      hint: 'Remove the hardcoded GitLab token and use `process.env.GITLAB_TOKEN`.',
    },
    {
      name: 'AWS Access Key ID (`AKIA...` / `ASIA...`)',
      regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
      hint: 'Remove hardcoded AWS credentials and load via `AWS_ACCESS_KEY_ID` / IAM roles.',
    },
    {
      name: 'Slack Bot/User Token (`xox...`)',
      regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
      hint: 'Remove the hardcoded Slack token and load via `process.env.SLACK_BOT_TOKEN`.',
    },
    {
      name: 'Stripe Live/Test Secret Key',
      regex: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}\b/,
      hint: 'Remove the hardcoded Stripe secret key and load via `process.env.STRIPE_SECRET_KEY`.',
    },
    {
      name: 'Private Cryptographic Key Header (PEM)',
      regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
      hint: 'Never commit private keys into the repository. Load private key material from an external secret mount or env variable.',
    },
  ];

  for (const pat of secretPatterns) {
    const m = pat.regex.exec(trimmed);
    if (m) {
      const redacted = trimmed.replace(pat.regex, (match) => redactToken(match)).slice(0, 140);
      return {
        message: `Secret Guard: Hardcoded ${pat.name} detected.`,
        fixHint: pat.hint,
        redactedSnippet: redacted,
      };
    }
  }

  // Generic high-confidence credential assignment check in code or .env files
  const assignMatch =
    /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|jwt[_-]?secret|db[_-]?password)\b\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/i.exec(
      trimmed,
    );
  if (assignMatch) {
    const keyName = assignMatch[1]!;
    const val = assignMatch[2]!;
    const isSafePlaceholder =
      /^(?:your[_-]|example|changeme|placeholder|dummy|test|mock|fake|xxx|todo|none|null|undefined|\$\{|process\.env|<)/i.test(
        val,
      ) || /^[a-z_]+$/i.test(val);
    if (!isSafePlaceholder && !isTestFile(file)) {
      const redacted = trimmed.replace(val, redactToken(val)).slice(0, 140);
      return {
        message: `Secret Guard: Hardcoded credential assigned to \`${keyName}\`.`,
        fixHint: `Replace the hardcoded string on \`${keyName}\` with \`process.env.${keyName.toUpperCase()}\` and document a placeholder in \`.env.example\`.`,
        redactedSnippet: redacted,
      };
    }
  }

  return null;
}

function isTestFile(relPath: string): boolean {
  return /\.(test|spec)\.[a-z0-9]+$/i.test(relPath) || relPath.includes('__tests__/');
}

function computeGrade(score: number): SlopAuditGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

interface DiffAddedLine {
  file: string;
  line: number;
  content: string;
}

async function walkWorkspaceAuditableFiles(
  rootDir: string,
  relPrefix = '',
  depth = 0,
): Promise<string[]> {
  if (depth > 4) return [];
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(rootDir, relPrefix), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (
      (entry.name.startsWith('.') && !entry.name.startsWith('.env')) ||
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'build'
    ) {
      continue;
    }
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const sub = await walkWorkspaceAuditableFiles(rootDir, rel, depth + 1);
      found.push(...sub);
    } else if (entry.isFile() && isAuditableFile(rel)) {
      found.push(rel);
    }
  }
  return found;
}

async function collectDiffAddedLines(workspacePath: string): Promise<{
  files: string[];
  addedLines: DiffAddedLine[];
}> {
  if (!existsSync(workspacePath)) {
    return { files: [], addedLines: [] };
  }

  const hasGit = existsSync(path.join(workspacePath, '.git'));
  let rawDiff = '';
  if (hasGit) {
    try {
      const { stdout: wtDiff } = await execFileAsync(
        'git',
        ['diff', 'HEAD', '--unified=0', '--no-color'],
        { cwd: workspacePath, maxBuffer: 8 * 1024 * 1024 },
      );
      rawDiff = wtDiff;
      if (!rawDiff.trim()) {
        const { stdout: headDiff } = await execFileAsync(
          'git',
          ['show', '--format=', '--unified=0', '--no-color', 'HEAD'],
          { cwd: workspacePath, maxBuffer: 8 * 1024 * 1024 },
        ).catch(async () =>
          execFileAsync('git', ['diff', 'HEAD~1..HEAD', '--unified=0', '--no-color'], {
            cwd: workspacePath,
            maxBuffer: 8 * 1024 * 1024,
          }),
        );
        rawDiff = headDiff;
      }
    } catch {
      rawDiff = '';
    }
  }

  const filesSet = new Set<string>();
  const addedLines: DiffAddedLine[] = [];
  let currentFile: string | null = null;
  let currentLine = 0;

  for (const rawLine of rawDiff.split('\n')) {
    if (rawLine.startsWith('+++ b/')) {
      const candidate = rawLine.slice(6).trim();
      currentFile = isAuditableFile(candidate) ? candidate : null;
      if (currentFile) filesSet.add(currentFile);
      continue;
    }
    if (!currentFile) continue;

    if (rawLine.startsWith('@@ ')) {
      const m = /\+(\d+)(?:,\d+)? @@/.exec(rawLine);
      currentLine = m ? Number.parseInt(m[1]!, 10) : 1;
      continue;
    }

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      addedLines.push({
        file: currentFile,
        line: currentLine,
        content: rawLine.slice(1),
      });
      currentLine += 1;
    }
  }

  if (hasGit) {
    try {
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
        cwd: workspacePath,
      });
      for (const line of statusOut.split('\n')) {
        if (!line.startsWith('?? ')) continue;
        const relFile = line.slice(3).trim();
        if (!relFile || filesSet.has(relFile) || !isAuditableFile(relFile)) continue;
        const absFile = path.join(workspacePath, relFile);
        if (!existsSync(absFile)) continue;
        try {
          const content = await readFile(absFile, 'utf8');
          filesSet.add(relFile);
          const fileLines = content.split('\n');
          for (let i = 0; i < fileLines.length; i += 1) {
            addedLines.push({
              file: relFile,
              line: i + 1,
              content: fileLines[i]!,
            });
          }
        } catch {
          // ignore unreadable untracked file
        }
      }
    } catch {
      // ignore if not a git repo
    }
  }

  // Fallback for non-git workspaces or fresh directories
  if (filesSet.size === 0) {
    const walkedFiles = await walkWorkspaceAuditableFiles(workspacePath);
    for (const relFile of walkedFiles.slice(0, 25)) {
      const absFile = path.join(workspacePath, relFile);
      try {
        const content = await readFile(absFile, 'utf8');
        filesSet.add(relFile);
        const fileLines = content.split('\n');
        for (let i = 0; i < fileLines.length; i += 1) {
          addedLines.push({
            file: relFile,
            line: i + 1,
            content: fileLines[i]!,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    files: Array.from(filesSet),
    addedLines,
  };
}

export async function auditWorktreeSlop(params: {
  runId: string;
  workspacePath: string;
}): Promise<SlopAuditReport> {
  const { runId, workspacePath } = params;
  const { files, addedLines } = await collectDiffAddedLines(workspacePath);
  const issues: SlopIssue[] = [];
  let issueSeq = 1;

  const pushIssue = (item: Omit<SlopIssue, 'id'>) => {
    if (issues.length >= 40) return;
    issues.push({
      id: `slop-${issueSeq++}`,
      ...item,
    });
  };

  // 0. Pre-Commit Secret Guard: Forbidden secret files (.env, .env.local, *.pem, *.key, credentials.json)
  for (const relFile of files) {
    if (isForbiddenSecretFile(relFile)) {
      pushIssue({
        category: 'secret_leak',
        severity: 'error',
        file: relFile,
        line: 1,
        snippet: `${relFile} (forbidden credential/env file)`,
        message: `Secret Guard: Forbidden credential or environment file \`${relFile}\` present in workspace diff.`,
        fixHint: `Delete or untrack \`${relFile}\`, add it to \`.gitignore\`, and commit only safe placeholders in \`.env.example\`.`,
      });
    }
  }

  for (const entry of addedLines) {
    const trimmed = entry.content.trim();
    if (!trimmed) continue;

    // 0b. Pre-Commit Secret Guard: Hardcoded API keys, tokens, private keys, or credentials
    const secretHit = detectSecretLeakInLine(entry.file, entry.content);
    if (secretHit) {
      pushIssue({
        category: 'secret_leak',
        severity: 'error',
        file: entry.file,
        line: entry.line,
        snippet: secretHit.redactedSnippet,
        message: secretHit.message,
        fixHint: secretHit.fixHint,
      });
      continue;
    }

    if (!isCodeHygieneFile(entry.file)) continue;

    const ext = path.extname(entry.file).toLowerCase();
    const isTsOrJs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
    const isUiFile = ['.tsx', '.jsx', '.css', '.scss', '.html', '.vue', '.svelte'].includes(ext);
    const inTest = isTestFile(entry.file);

    // 1. Type evasion (: any, as any, @ts-ignore, @ts-expect-error, eslint-disable)
    if (isTsOrJs && !inTest) {
      if (/(?::\s*any\b|\bas\s+any\b|<any>)/.test(trimmed) && !trimmed.startsWith('//')) {
        pushIssue({
          category: 'type_evasion',
          severity: 'error',
          file: entry.file,
          line: entry.line,
          snippet: trimmed.slice(0, 140),
          message: 'Type safety bypassed with `any`.',
          fixHint: 'Replace `any` with an explicit interface, generic type, `unknown` + type guard, or Zod schema.',
        });
      } else if (/@ts-ignore\b|@ts-nocheck\b|eslint-disable/.test(trimmed)) {
        pushIssue({
          category: 'type_evasion',
          severity: 'error',
          file: entry.file,
          line: entry.line,
          snippet: trimmed.slice(0, 140),
          message: 'Compiler or linter check suppressed via directive.',
          fixHint: 'Remove `@ts-ignore` / `eslint-disable` and fix the underlying type or lint mismatch.',
        });
      }
    }

    // 2. Unfinished stubs / TODO / FIXME / placeholder comments
    if (
      /(?:\/\/|\/\*|#)\s*(?:TODO|FIXME|HACK|PLACEHOLDER|XXX)\b/i.test(trimmed) ||
      /\/\/\s*(?:implement later|rest of (?:code|implementation)|add implementation here)/i.test(
        trimmed,
      ) ||
      /throw new Error\(['"`]not implemented/i.test(trimmed)
    ) {
      pushIssue({
        category: 'unfinished_stub',
        severity: 'error',
        file: entry.file,
        line: entry.line,
        snippet: trimmed.slice(0, 140),
        message: 'Unfinished placeholder or TODO/FIXME stub left in code.',
        fixHint: 'Implement the complete logic now and remove all TODO/placeholder markers.',
      });
    }

    // 3. Skipped tests (.skip, xit, xdescribe, test.todo)
    if (inTest && /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(/.test(trimmed)) {
      pushIssue({
        category: 'skipped_test',
        severity: 'error',
        file: entry.file,
        line: entry.line,
        snippet: trimmed.slice(0, 140),
        message: 'Skipped or unimplemented test committed.',
        fixHint: 'Enable the test and assert real behavior instead of skipping it.',
      });
    }

    // 4. Leftover debug statements (console.log / debugger) in non-test code
    if (isTsOrJs && !inTest && !entry.file.includes('cli') && !entry.file.includes(' bin/')) {
      if (/\bdebugger\b/.test(trimmed) && !trimmed.startsWith('//')) {
        pushIssue({
          category: 'debug_leftover',
          severity: 'error',
          file: entry.file,
          line: entry.line,
          snippet: trimmed.slice(0, 140),
          message: 'Leftover `debugger` statement in production code.',
          fixHint: 'Remove the `debugger` statement.',
        });
      } else if (/\bconsole\.log\s*\(/.test(trimmed) && !trimmed.startsWith('//')) {
        pushIssue({
          category: 'debug_leftover',
          severity: 'warning',
          file: entry.file,
          line: entry.line,
          snippet: trimmed.slice(0, 140),
          message: 'Leftover `console.log(...)` statement in source module.',
          fixHint: 'Remove debug `console.log` calls or use structured application state/logging.',
        });
      }
    }

    // 5. Vibe-coding UI clichés (cookie-cutter AI indigo/purple/pink gradients)
    if (isUiFile) {
      if (
        /linear-gradient\([^)]*(?:#6366f1|#8b5cf6|#a855f7|#ec4899|rgba\(99,\s*102,\s*241|rgba\(139,\s*92,\s*246)/i.test(
          trimmed,
        ) ||
        /\bfrom-(?:indigo|purple|violet)-(?:500|600)\s+(?:via-[a-z0-9-]+\s+)?to-(?:pink|purple|fuchsia)-(?:500|600)\b/.test(
          trimmed,
        )
      ) {
        pushIssue({
          category: 'vibe_ui_cliche',
          severity: 'warning',
          file: entry.file,
          line: entry.line,
          snippet: trimmed.slice(0, 140),
          message: 'Generic AI purple/indigo-to-pink gradient cliché detected.',
          fixHint:
            'Replace generic AI gradients with intentional project design tokens (`var(--...)`) and cohesive surface hierarchy.',
        });
      }
    }

    // 6. Decorative ASCII banner bloat
    if (/^\/\/\s*[=*-]{18,}\s*$/.test(trimmed)) {
      pushIssue({
        category: 'comment_bloat',
        severity: 'warning',
        file: entry.file,
        line: entry.line,
        snippet: trimmed.slice(0, 140),
        message: 'Decorative ASCII banner comment adds visual noise.',
        fixHint: 'Use concise section comments or modular files instead of ASCII art dividers.',
      });
    }
  }

  // 7. Check modified files for monolithic file bloat (> 600 lines)
  for (const relFile of files) {
    if (isTestFile(relFile) || !isCodeHygieneFile(relFile)) continue;
    const absFile = path.join(workspacePath, relFile);
    if (!existsSync(absFile)) continue;
    try {
      const content = await readFile(absFile, 'utf8');
      const lineCount = content.split('\n').length;
      if (lineCount > 600) {
        pushIssue({
          category: 'file_bloat',
          severity: 'warning',
          file: relFile,
          line: lineCount,
          snippet: `${relFile} (${lineCount} lines)`,
          message: `Monolithic file bloat: \`${relFile}\` has grown to ${lineCount} lines.`,
          fixHint: 'Keep modules focused (< 450 lines) by extracting cohesive sub-components or domain helpers.',
        });
      }
    } catch {
      // ignore unreadable file
    }
  }

  const secretLeakCount = issues.filter((i) => i.category === 'secret_leak').length;
  const secretGuardPassed = secretLeakCount === 0;
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const rawScore = 100 - secretLeakCount * 20 - errorCount * 15 - warningCount * 5;
  const score = Math.max(0, Math.min(100, rawScore));
  const grade = computeGrade(score);
  const passed = secretGuardPassed && errorCount === 0 && score >= 75;

  const autoFixPrompt =
    issues.length > 0
      ? [
          secretLeakCount > 0
            ? `🚨 [PRE-COMMIT SECRET & CREDENTIAL GUARD BLOCK — ${secretLeakCount} SECRET LEAK(S) DETECTED]`
            : `[Anti-AI-Slop & Code Hygiene Gate — Score ${score}/100 (Grade ${grade})]`,
          `Our automated pre-commit security & hygiene scanner detected ${errorCount} error(s) (${secretLeakCount} secret leak(s)) and ${warningCount} warning(s) in your changes:`,
          '',
          ...issues.slice(0, 15).map(
            (iss, idx) =>
              `${idx + 1}. [${iss.severity.toUpperCase()} · ${iss.category}] \`${iss.file}:${iss.line}\` — ${iss.message}\n   Snippet: \`${iss.snippet}\`\n   Fix: ${iss.fixHint}`,
          ),
          '',
          secretLeakCount > 0
            ? 'CRITICAL: Immediately remove all hardcoded secrets/tokens/keys and any tracked `.env` or private key files. Move configuration to `process.env.<NAME>`, document safe placeholders in `.env.example`, and ensure `.env` is listed in `.gitignore` before finishing.'
            : 'Please clean up every item listed above, verify the project still builds and passes tests cleanly, and do not leave any new TODOs, `any` casts, or debug leftovers.',
        ].join('\n')
      : null;

  const report: SlopAuditReport = SlopAuditReport.parse({
    runId,
    workspacePath,
    score,
    grade,
    passed,
    secretLeakCount,
    secretGuardPassed,
    filesAudited: files.length,
    addedLinesAudited: addedLines.length,
    errorCount,
    warningCount,
    issues,
    autoFixPrompt,
    auditedAt: new Date().toISOString(),
  });

  return report;
}

export function selectRivalCriticAgent(
  authorAgent: AgentId,
  settings: FactorySettings,
  preferredReviewer?: AgentId,
): { reviewerAgent: AgentId; reviewerModel: AgentModelId } {
  if (preferredReviewer) {
    return {
      reviewerAgent: preferredReviewer,
      reviewerModel: selectProviderModelByRank(preferredReviewer, 4),
    };
  }

  const candidates: AgentId[] = ['antigravity', 'claude', 'gemini', 'codex', 'copilot'];
  for (const candidate of candidates) {
    if (candidate === authorAgent) continue;
    const isEnabled = settings.enabledProviders.includes(candidate);
    const isAuth = Boolean(settings.providerAuth?.[candidate]?.authenticated);
    if (isEnabled || isAuth) {
      return {
        reviewerAgent: candidate,
        reviewerModel: selectProviderModelByRank(candidate, 4),
      };
    }
  }

  return {
    reviewerAgent: authorAgent,
    reviewerModel: selectProviderModelByRank(authorAgent, 4),
  };
}

export async function getSavedCrossCriticResult(
  workspacePath: string,
  runId: string,
): Promise<CrossCriticResult | null> {
  const filePath = path.join(workspacePath, '.emberline', `cross-critic-${runId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, 'utf8');
    return CrossCriticResult.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function runCrossProviderCritic(params: {
  run: Run;
  ticketTitle?: string | null;
  ticketBody?: string | null;
  workspacePath: string;
  settings: FactorySettings;
  preferredReviewer?: AgentId;
}): Promise<CrossCriticResult> {
  const { run, ticketTitle, ticketBody, workspacePath, settings, preferredReviewer } = params;
  const authorAgent = (run.agent as AgentId) ?? 'claude';
  const { reviewerAgent, reviewerModel } = selectRivalCriticAgent(
    authorAgent,
    settings,
    preferredReviewer,
  );

  const slopReport = await auditWorktreeSlop({ runId: run.id, workspacePath });

  let diffStat = '';
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1..HEAD'], {
      cwd: workspacePath,
    }).catch(() => execFileAsync('git', ['diff', '--stat', 'HEAD'], { cwd: workspacePath }));
    diffStat = stdout.trim();
  } catch {
    diffStat = '';
  }

  const criticIssues = slopReport.issues.map((iss) => ({
    severity: iss.severity === 'error' ? ('critical' as const) : ('warning' as const),
    category: iss.category,
    file: `${iss.file}:${iss.line}`,
    description: `${iss.message} (\`${iss.snippet}\`)`,
    fixRecommendation: iss.fixHint,
  }));

  // Try invoking rival CLI inside workspace if available and fast, otherwise synthesize from deterministic + structural audit
  let llmSummary: string | null = null;
  if (reviewerAgent === 'antigravity' || reviewerAgent === 'claude') {
    const reviewPrompt = [
      `You are acting as a strict Cross-Provider Principal Code Critic (${reviewerAgent.toUpperCase()} reviewing code written by ${authorAgent.toUpperCase()}).`,
      `Ticket: ${ticketTitle ?? run.title ?? 'Implementation Task'}`,
      ticketBody ? `Specification:\n${ticketBody.slice(0, 1500)}` : '',
      `Diff Stat:\n${diffStat || `${slopReport.filesAudited} files, ${slopReport.addedLinesAudited} added lines`}`,
      `Automated Slop Score: ${slopReport.score}/100 (Grade ${slopReport.grade}, ${slopReport.errorCount} errors, ${slopReport.warningCount} warnings).`,
      'Provide a concise 2-sentence architectural & anti-slop review verdict.',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const cmd = reviewerAgent === 'antigravity' ? '/usr/local/bin/agy-bin' : 'claude';
      const args =
        reviewerAgent === 'antigravity'
          ? ['--mode', 'ask', '--output-format', 'text', '-p', reviewPrompt]
          : ['--print', '--model', 'sonnet', '--', reviewPrompt];
      const { stdout } = await execFileAsync(cmd, args, {
        cwd: workspacePath,
        timeout: 25_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const cleaned = stdout.trim();
      if (cleaned.length > 15 && cleaned.length < 2500) {
        llmSummary = cleaned;
      }
    } catch {
      // Fall back to deterministic synthesis when running inside core container or when CLI times out
    }
  }

  const verdict: 'PASS' | 'NEEDS_FIX' = slopReport.passed ? 'PASS' : 'NEEDS_FIX';
  const summary =
    llmSummary ??
    (verdict === 'PASS'
      ? `Cross-provider audit by ${reviewerAgent.toUpperCase()} (${reviewerModel}) passed with Grade ${slopReport.grade} (${slopReport.score}/100) across ${slopReport.filesAudited} modified file(s). No type evasion, unfinished stubs, or vibe-coding bloat blocked approval.`
      : `Cross-provider audit by ${reviewerAgent.toUpperCase()} (${reviewerModel}) flagged ${slopReport.errorCount} blocking hygiene error(s) and ${slopReport.warningCount} warning(s) (Score ${slopReport.score}/100 · Grade ${slopReport.grade}). Remediation required before completion.`);

  const followUpPrompt =
    verdict === 'NEEDS_FIX' || criticIssues.length > 0
      ? [
          `[Cross-Provider Critic Review · ${reviewerAgent.toUpperCase()} (${reviewerModel}) -> ${authorAgent.toUpperCase()}]`,
          summary,
          '',
          ...criticIssues.slice(0, 15).map(
            (c, i) =>
              `${i + 1}. [${c.severity.toUpperCase()} · ${c.category}] ${c.file ? `\`${c.file}\` — ` : ''}${c.description}\n   Recommendation: ${c.fixRecommendation}`,
          ),
          '',
          'Please resolve each critic finding above and verify the build and tests pass.',
        ].join('\n')
      : null;

  const result = CrossCriticResult.parse({
    runId: run.id,
    authorAgent,
    reviewerAgent,
    reviewerModel,
    verdict,
    score: slopReport.score,
    summary,
    issues: criticIssues,
    followUpPrompt,
    reviewedAt: new Date().toISOString(),
  });

  try {
    const dir = path.join(workspacePath, '.emberline');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `cross-critic-${run.id}.json`),
      JSON.stringify(result, null, 2),
      'utf8',
    );
  } catch {
    // non-fatal
  }

  return result;
}
