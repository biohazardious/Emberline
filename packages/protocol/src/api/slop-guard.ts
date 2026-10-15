/** API contracts: 3-Layer Anti-AI-Slop, Anti-Vibe-Coding & Cross-Provider Critic (F12). */
import { z } from 'zod';
import { AgentId, AgentModelId } from './runs.js';

export const SlopIssueCategory = z.enum([
  'secret_leak',
  'type_evasion',
  'unfinished_stub',
  'debug_leftover',
  'vibe_ui_cliche',
  'comment_bloat',
  'file_bloat',
  'skipped_test',
]);
export type SlopIssueCategory = z.infer<typeof SlopIssueCategory>;

export const SlopIssueSeverity = z.enum(['error', 'warning']);
export type SlopIssueSeverity = z.infer<typeof SlopIssueSeverity>;

export const SlopIssue = z.object({
  id: z.string(),
  category: SlopIssueCategory,
  severity: SlopIssueSeverity,
  file: z.string(),
  line: z.number().int().nonnegative(),
  snippet: z.string(),
  message: z.string(),
  fixHint: z.string(),
});
export type SlopIssue = z.infer<typeof SlopIssue>;

export const SlopAuditGrade = z.enum(['A', 'B', 'C', 'D', 'F']);
export type SlopAuditGrade = z.infer<typeof SlopAuditGrade>;

export const SlopAuditReport = z.object({
  runId: z.string(),
  workspacePath: z.string(),
  score: z.number().int().min(0).max(100),
  grade: SlopAuditGrade,
  passed: z.boolean(),
  secretLeakCount: z.number().int().nonnegative().default(0),
  secretGuardPassed: z.boolean().default(true),
  filesAudited: z.number().int().nonnegative(),
  addedLinesAudited: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  issues: z.array(SlopIssue),
  autoFixPrompt: z.string().nullable(),
  auditedAt: z.string(),
});
export type SlopAuditReport = z.infer<typeof SlopAuditReport>;

export const CrossCriticIssue = z.object({
  severity: z.enum(['critical', 'warning', 'nit']),
  category: z.string(),
  file: z.string().nullable().default(null),
  description: z.string(),
  fixRecommendation: z.string(),
});
export type CrossCriticIssue = z.infer<typeof CrossCriticIssue>;

export const CrossCriticResult = z.object({
  runId: z.string(),
  authorAgent: AgentId,
  reviewerAgent: AgentId,
  reviewerModel: AgentModelId,
  verdict: z.enum(['PASS', 'NEEDS_FIX']),
  score: z.number().int().min(0).max(100),
  summary: z.string(),
  issues: z.array(CrossCriticIssue),
  followUpPrompt: z.string().nullable(),
  /** `rival`: the reviewer CLI actually reviewed the diff; `deterministic`: only the local audit ran. */
  reviewSource: z.enum(['rival', 'deterministic']).default('deterministic'),
  reviewedAt: z.string(),
});
export type CrossCriticResult = z.infer<typeof CrossCriticResult>;

export const RunCrossCriticBody = z.object({
  reviewerAgent: AgentId.optional(),
  autoDispatchFix: z.boolean().default(false),
});
export type RunCrossCriticBody = z.input<typeof RunCrossCriticBody>;
