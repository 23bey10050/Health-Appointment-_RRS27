import {
  availabilityResponseSchema,
  createLeaveResponseSchema,
  leavePreviewResponseSchema,
  leaveSchema,
  listDoctorsResponseSchema,
  type AvailabilityResponse,
  type CreateLeaveResponse,
  type Leave,
  type LeavePreviewResponse,
  type ListDoctorsQuery,
  type ListDoctorsResponse,
} from '@health/contracts';
import { z } from 'zod';

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

/**
 * A doctor's own leave days - there is no doctor id anywhere in these calls, on purpose, the same
 * way `getMySchedule` has none either. The API reads who is asking from the access token, so there
 * is nothing here a request could tamper with to reach someone else's calendar.
 */
export function listMyLeaves(): Promise<Leave[]> {
  return apiRequest('/doctors/me/leaves', z.array(leaveSchema));
}

export function previewLeaveImpact(leaveDate: string): Promise<LeavePreviewResponse> {
  const search = toQueryString({ leaveDate });
  return apiRequest(`/doctors/me/leaves/preview${search}`, leavePreviewResponseSchema);
}

export function addMyLeave(leaveDate: string, reason?: string): Promise<CreateLeaveResponse> {
  return apiRequest('/doctors/me/leaves', createLeaveResponseSchema, {
    method: 'POST',
    body: reason ? { leaveDate, reason } : { leaveDate },
  });
}

export function deleteMyLeave(leaveId: string): Promise<void> {
  return apiRequest(`/doctors/me/leaves/${leaveId}`, z.void(), { method: 'DELETE' });
}
