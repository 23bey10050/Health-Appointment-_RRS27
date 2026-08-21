import {
  availabilityResponseSchema,
  listDoctorsResponseSchema,
  type AvailabilityResponse,
  type ListDoctorsQuery,
  type ListDoctorsResponse,
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

export function listDoctors(query: Partial<ListDoctorsQuery> = {}): Promise<ListDoctorsResponse> {
  const search = toQueryString({
    specialization: query.specialization,
    page: query.page,
    pageSize: query.pageSize,
  });
  return apiRequest(`/doctors${search}`, listDoctorsResponseSchema);
}

export function getAvailability(
  doctorId: string,
  from: string,
  to: string,
): Promise<AvailabilityResponse> {
  const search = toQueryString({ from, to });
  return apiRequest(`/doctors/${doctorId}/availability${search}`, availabilityResponseSchema);
}
