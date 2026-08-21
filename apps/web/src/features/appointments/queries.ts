import type { PrescriptionItem } from '@health/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as appointmentsApi from '../../lib/api/appointments.js';

export const appointmentKeys = {
  all: ['appointments'] as const,
  mine: () => [...appointmentKeys.all, 'mine'] as const,
  detail: (id: string) => [...appointmentKeys.all, 'detail', id] as const,
  schedule: (from: string, to: string) => [...appointmentKeys.all, 'schedule', from, to] as const,
};

export function useMyAppointments() {
  return useQuery({
    queryKey: appointmentKeys.mine(),
    queryFn: appointmentsApi.listMyAppointments,
  });
}

export function useAppointment(id: string | undefined) {
  return useQuery({
    queryKey: appointmentKeys.detail(id ?? ''),
    queryFn: () => appointmentsApi.getAppointment(id!),
    enabled: id !== undefined,
    // The AI summary and calendar sync both settle a few seconds after the row this reads
    // already exists - polling gently here is what lets the confirmation and detail screens show
    // "still working on it" turn into the real answer without the visitor doing anything.
    refetchInterval: (query) => {
      const data = query.state.data;
      const stillWorking =
        data?.aiPrevisitStatus === 'pending' || data?.aiPostvisitStatus === 'pending';
      return stillWorking ? 3000 : false;
    },
  });
}

export function useHoldSlot() {
  return useMutation({
    mutationFn: ({ doctorId, start }: { doctorId: string; start: string }) =>
      appointmentsApi.holdSlot(doctorId, start),
  });
}

export function useConfirmHold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ holdId, symptoms }: { holdId: string; symptoms: string }) =>
      appointmentsApi.confirmHold(holdId, symptoms),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: appointmentKeys.mine() });
    },
  });
}

export function useCancelAppointment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      appointmentsApi.cancelAppointment(id, reason),
    onSuccess: (updated) => {
      queryClient.setQueryData(appointmentKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: appointmentKeys.mine() });
    },
  });
}

export function useMySchedule(from: string, to: string) {
  return useQuery({
    queryKey: appointmentKeys.schedule(from, to),
    queryFn: () => appointmentsApi.getMySchedule(from, to),
  });
}

export function useSubmitNotes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      doctorNotes,
      prescription,
    }: {
      id: string;
      doctorNotes: string;
      prescription: PrescriptionItem[];
    }) => appointmentsApi.submitNotes(id, doctorNotes, prescription),
    onSuccess: (updated) => {
      queryClient.setQueryData(appointmentKeys.detail(updated.id), updated);
      // The visit just moved out of "confirmed" and off today's open list, in whichever day's
      // schedule it belongs to - easier to drop every cached schedule page than to work out which
      // one this appointment was on.
      void queryClient.invalidateQueries({ queryKey: appointmentKeys.all });
    },
  });
}
