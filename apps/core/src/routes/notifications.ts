import type {
  NotificationSettings,
  TestNotificationResponse,
  UpdateNotificationSettingsBody,
} from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { NotificationService } from '../notifications/service.js';

export function registerNotificationRoutes(app: FastifyInstance, notifications: NotificationService): void {
  app.get('/api/notifications', async (): Promise<NotificationSettings> => notifications.getSettings());

  app.patch<{ Body: UpdateNotificationSettingsBody }>(
    '/api/notifications',
    async (request): Promise<NotificationSettings> => notifications.updateSettings(request.body ?? {}),
  );

  app.post('/api/notifications/test', async (): Promise<TestNotificationResponse> => notifications.sendTest());
}
