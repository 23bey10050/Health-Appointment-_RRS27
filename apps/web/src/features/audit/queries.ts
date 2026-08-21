import type { ListAuditLogQuery } from '@health/contracts';
import { useQuery } from '@tanstack/react-query';

import * as auditApi from '../../lib/api/audit.js';

export const auditKeys = {
  all: ['audit-log'] as const,
  list: (query: Partial<ListAuditLogQuery>) => [...auditKeys.all, query] as const,
};

export function useAuditLog(query: Partial<ListAuditLogQuery> = {}) {
  return useQuery({
    queryKey: auditKeys.list(query),
    queryFn: () => auditApi.listAuditLog(query),
  });
}
