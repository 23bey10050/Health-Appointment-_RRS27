import {
  appointmentSchema,
  holdResponseSchema,
  type Appointment,
  type HoldResponse,
  type PrescriptionItem,
} from '@health/contracts';
import { z } from 'zod';

import { apiRequest } from '../api-client.js';

export function holdSlot(doctorId: string, start: string): Promise<HoldResponse> {
  return apiRequest('/appointments/hold', holdResponseSchema, {
    method: 'POST',
    body: { doctorId, start },
  });
}

export function confirmHold(holdId: string, symptoms: string): Promise<Appointment> {
  return apiRequest(`/appointments/${holdId}/confirm`, appointmentSchema, {
    method: 'POST',
    body: { symptoms },
  });
}

export function listMyAppointments(): Promise<Appointment[]> {
  return apiRequest('/appointments/mine', z.array(appointmentSchema));
}

export function getAppointment(id: string): Promise<Appointment> {
  return apiRequest(`/appointments/${id}`, appointmentSchema);
}

export function cancelAppointment(id: string, reason?: string): Promise<Appointment> {
  return apiRequest(`/appointments/${id}`, appointmentSchema, {
    method: 'DELETE',
    body: reason ? { reason } : {},
  });
}

/** A doctor's own day, not a doctor id in the URL at all - the API already knows who is asking
 *  from the access token, the same way `listMyAppointments` never takes a patient id either. */
export function getMySchedule(from: string, to: string): Promise<Appointment[]> {
  const search = new URLSearchParams({ from, to }).toString();
  return apiRequest(`/appointments/schedule?${search}`, z.array(appointmentSchema));
}

export function submitNotes(
  id: string,
  doctorNotes: string,
  prescription: PrescriptionItem[],
): Promise<Appointment> {
  return apiRequest(`/appointments/${id}/notes`, appointmentSchema, {
    method: 'POST',
    body: { doctorNotes, prescription },
  });
}
