import {
  availabilityResponseSchema,
  createLeaveResponseSchema,
  doctorSchema,
  leavePreviewResponseSchema,
  leaveSchema,
  listDoctorsResponseSchema,
  workingHourSchema,
  type AvailabilityResponse,
  type CreateDoctorRequest,
  type CreateLeaveResponse,
  type Doctor,
  type Leave,
  type LeavePreviewResponse,
  type ListDoctorsQuery,
  type ListDoctorsResponse,
  type UpdateDoctorRequest,
  type WorkingHour,
  type WorkingHourInput,
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

export function getDoctor(doctorId: string): Promise<Doctor> {
  return apiRequest(`/doctors/${doctorId}`, doctorSchema);
}

/**
 * The admin-facing roster and every admin action on a doctor's account below - unlike everything
 * above, these all take a doctor id, since an admin is managing someone else's calendar, not their
 * own.
 */
export function listDoctorsForAdmin(
  query: Partial<ListDoctorsQuery> = {},
): Promise<ListDoctorsResponse> {
  const search = toQueryString({
    specialization: query.specialization,
    page: query.page,
    pageSize: query.pageSize,
  });
  return apiRequest(`/admin/doctors${search}`, listDoctorsResponseSchema);
}

export function createDoctor(input: CreateDoctorRequest): Promise<Doctor> {
  return apiRequest('/admin/doctors', doctorSchema, { method: 'POST', body: input });
}

export function updateDoctor(doctorId: string, input: UpdateDoctorRequest): Promise<Doctor> {
  return apiRequest(`/admin/doctors/${doctorId}`, doctorSchema, { method: 'PATCH', body: input });
}

export function addWorkingHour(doctorId: string, input: WorkingHourInput): Promise<WorkingHour> {
  return apiRequest(`/admin/doctors/${doctorId}/working-hours`, workingHourSchema, {
    method: 'POST',
    body: input,
  });
}

export function deleteWorkingHour(doctorId: string, workingHourId: string): Promise<void> {
  return apiRequest(`/admin/doctors/${doctorId}/working-hours/${workingHourId}`, z.void(), {
    method: 'DELETE',
  });
}

export function listLeavesForDoctor(doctorId: string): Promise<Leave[]> {
  return apiRequest(`/admin/doctors/${doctorId}/leaves`, z.array(leaveSchema));
}

export function previewLeaveImpactForDoctor(
  doctorId: string,
  leaveDate: string,
): Promise<LeavePreviewResponse> {
  const search = toQueryString({ leaveDate });
  return apiRequest(
    `/admin/doctors/${doctorId}/leaves/preview${search}`,
    leavePreviewResponseSchema,
  );
}

export function addLeaveForDoctor(
  doctorId: string,
  leaveDate: string,
  reason?: string,
): Promise<CreateLeaveResponse> {
  return apiRequest(`/admin/doctors/${doctorId}/leaves`, createLeaveResponseSchema, {
    method: 'POST',
    body: reason ? { leaveDate, reason } : { leaveDate },
  });
}

export function deleteLeaveForDoctor(doctorId: string, leaveId: string): Promise<void> {
  return apiRequest(`/admin/doctors/${doctorId}/leaves/${leaveId}`, z.void(), {
    method: 'DELETE',
  });
}
