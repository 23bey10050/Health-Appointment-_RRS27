import {
  listDeadLettersResponseSchema,
  notificationSummaryResponseSchema,
  retryNotificationResponseSchema,
  type DeadLetterNotification,
  type NotificationSummaryResponse,
} from '@health/contracts';

import { apiRequest } from '../api-client.js';

export function getNotificationSummary(): Promise<NotificationSummaryResponse> {
  return apiRequest('/admin/notifications/summary', notificationSummaryResponseSchema);
}

export function listDeadLetters(): Promise<DeadLetterNotification[]> {
  return apiRequest('/admin/notifications/dead-letter', listDeadLettersResponseSchema);
}

export function retryNotification(id: string): Promise<{ retried: true }> {
  return apiRequest(`/admin/notifications/${id}/retry`, retryNotificationResponseSchema, {
    method: 'POST',
  });
}
