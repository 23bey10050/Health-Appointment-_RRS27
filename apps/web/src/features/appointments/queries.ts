import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as appointmentsApi from '../../lib/api/appointments.js';

export const appointmentKeys = {
  all: ['appointments'] as const,
  mine: () => [...appointmentKeys.all, 'mine'] as const,
  detail: (id: string) => [...appointmentKeys.all, 'detail', id] as const,
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
