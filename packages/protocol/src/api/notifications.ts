/** API contracts: notifications (ntfy / webhook). */
import { z } from 'zod';

export const NotificationProvider = z.enum(['ntfy', 'webhook']);
export type NotificationProvider = z.infer<typeof NotificationProvider>;

export const NotificationSettings = z.object({
  enabled: z.boolean(),
  provider: NotificationProvider,
  /** Target URL (e.g. https://ntfy.sh/my-emberline-topic or Discord/Slack/generic webhook URL). */
  url: z.string(),
  /** Optional Bearer token (for private ntfy servers or authenticated webhooks). */
  token: z.string().nullable(),
  onRateLimited: z.boolean(),
  onQuotaResumed: z.boolean(),
  onWaitingInput: z.boolean(),
  onRunFinished: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

/** What the API returns: the token itself never leaves the server (S14). */
export const NotificationSettingsView = NotificationSettings.omit({ token: true }).extend({
  tokenConfigured: z.boolean(),
});
export type NotificationSettingsView = z.infer<typeof NotificationSettingsView>;

export const UpdateNotificationSettingsBody = z
  .object({
    enabled: z.boolean(),
    provider: NotificationProvider,
    url: z.string().trim().max(1000),
    token: z.string().trim().max(500).nullable(),
    onRateLimited: z.boolean(),
    onQuotaResumed: z.boolean(),
    onWaitingInput: z.boolean(),
    onRunFinished: z.boolean(),
  })
  .partial();
export type UpdateNotificationSettingsBody = z.input<typeof UpdateNotificationSettingsBody>;

export const TestNotificationResponse = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type TestNotificationResponse = z.infer<typeof TestNotificationResponse>;
