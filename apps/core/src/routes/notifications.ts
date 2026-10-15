import type {
  NotificationSettings,
  NotificationSettingsView,
  TestNotificationResponse,
  UpdateNotificationSettingsBody,
} from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { NotificationService } from '../notifications/service.js';

/** S14: the stored token is write-only; clients only learn whether one is set. */
function toView({ token, ...rest }: NotificationSettings): NotificationSettingsView {
  return { ...rest, tokenConfigured: Boolean(token) };
}

export function registerNotificationRoutes(app: FastifyInstance, notifications: NotificationService): void {
  app.get('/api/notifications', async (): Promise<NotificationSettingsView> => toView(notifications.getSettings()));

  app.patch<{ Body: UpdateNotificationSettingsBody }>(
    '/api/notifications',
    async (request): Promise<NotificationSettingsView> => toView(notifications.updateSettings(request.body ?? {})),
  );

  app.post('/api/notifications/test', async (): Promise<TestNotificationResponse> => notifications.sendTest());
}
