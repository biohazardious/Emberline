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
  updatedAt: z.string(),
});
export type ClaudeUsageTelemetry = z.infer<typeof ClaudeUsageTelemetry>;
