/** API contracts: Claude OAuth usage & token telemetry (5h / 7d windows + token counts). */
import { z } from 'zod';

export const ClaudeTokenBucket = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
});
export type ClaudeTokenBucket = z.infer<typeof ClaudeTokenBucket>;

export const ClaudeUsageWindow = z.object({
  utilizationPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
  severity: z.string().default('normal'),
});
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

export const ProviderTokenTelemetry = z.object({
  hourlyTokens: ClaudeTokenBucket,
  dailyTokens: ClaudeTokenBucket,
  weeklyTokens: ClaudeTokenBucket,
});
export type ProviderTokenTelemetry = z.infer<typeof ProviderTokenTelemetry>;

/** One quota pool shared by a group of models (e.g. all Gemini models), as the provider reports it. */
export const ProviderQuotaGroup = z.object({
  label: z.string(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
});
export type ProviderQuotaGroup = z.infer<typeof ProviderQuotaGroup>;

export const ProviderQuota = z.object({
  available: z.boolean(),
  groups: z.array(ProviderQuotaGroup),
  /** Why no numbers are shown (not logged in, token expired, request failed). */
  reason: z.string().nullable(),
  updatedAt: z.string(),
});
export type ProviderQuota = z.infer<typeof ProviderQuota>;

export const ClaudeUsageTelemetry = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
  subscriptionType: z.string().nullable(),
  rateLimitTier: z.string().nullable(),
  tokenExpiresAt: z.string().nullable(),
  fiveHour: ClaudeUsageWindow.nullable(),
  sevenDay: ClaudeUsageWindow.nullable(),
  extraUsage: z
    .object({
      enabled: z.boolean(),
      usedUsd: z.number(),
      limitUsd: z.number(),
      utilizationPercent: z.number(),
      disabledReason: z.string().nullable(),
    })
    .nullable(),
  hourlyTokens: ClaudeTokenBucket,
  dailyTokens: ClaudeTokenBucket,
  weeklyTokens: ClaudeTokenBucket,
  providerTokens: z.record(z.string(), ProviderTokenTelemetry).optional(),
  /** Quota windows reported by other providers' own services (e.g. Antigravity), keyed by provider id. */
  providerQuotas: z.record(z.string(), ProviderQuota).optional(),
  updatedAt: z.string(),
});
export type ClaudeUsageTelemetry = z.infer<typeof ClaudeUsageTelemetry>;
