import {
  appointmentSchema,
  holdResponseSchema,
  type Appointment,
  type HoldResponse,
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
