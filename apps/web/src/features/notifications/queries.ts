import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as notificationsApi from '../../lib/api/notifications.js';

export const notificationKeys = {
  all: ['notifications'] as const,
  summary: () => [...notificationKeys.all, 'summary'] as const,
  deadLetters: () => [...notificationKeys.all, 'dead-letters'] as const,
};

export function useNotificationSummary() {
  return useQuery({
    queryKey: notificationKeys.summary(),
    queryFn: notificationsApi.getNotificationSummary,
  });
}

export function useDeadLetters() {
  return useQuery({
    queryKey: notificationKeys.deadLetters(),
    queryFn: notificationsApi.listDeadLetters,
  });
}

export function useRetryNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.retryNotification(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
