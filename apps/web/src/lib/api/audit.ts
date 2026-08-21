import {
  listAuditLogResponseSchema,
  type ListAuditLogQuery,
  type ListAuditLogResponse,
} from '@health/contracts';

import { apiRequest } from '../api-client.js';

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function listAuditLog(
  query: Partial<ListAuditLogQuery> = {},
): Promise<ListAuditLogResponse> {
  const search = toQueryString({
    actorId: query.actorId,
    action: query.action,
    entityType: query.entityType,
    page: query.page,
    pageSize: query.pageSize,
  });
  return apiRequest(`/admin/audit-log${search}`, listAuditLogResponseSchema);
}
