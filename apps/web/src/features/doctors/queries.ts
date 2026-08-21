import type { ListDoctorsQuery } from '@health/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { appointmentKeys } from '../appointments/queries.js';

import * as doctorsApi from '../../lib/api/doctors.js';

export const doctorKeys = {
  all: ['doctors'] as const,
  list: (query: Partial<ListDoctorsQuery>) => [...doctorKeys.all, 'list', query] as const,
  availability: (doctorId: string, from: string, to: string) =>
    [...doctorKeys.all, doctorId, 'availability', from, to] as const,
};

export const leaveKeys = {
  all: ['leaves'] as const,
  mine: () => [...leaveKeys.all, 'mine'] as const,
};

export function useDoctors(query: Partial<ListDoctorsQuery> = {}) {
  return useQuery({
    queryKey: doctorKeys.list(query),
    queryFn: () => doctorsApi.listDoctors(query),
  });
}

export function useAvailability(doctorId: string, from: string, to: string) {
  return useQuery({
    queryKey: doctorKeys.availability(doctorId, from, to),
    queryFn: () => doctorsApi.getAvailability(doctorId, from, to),
    // Someone else can take a slot at any moment - treating this as fresh for the usual 30s
    // default would mean showing a slot as bookable seconds after it stopped being one.
    staleTime: 5000,
  });
}

export function useMyLeaves() {
  return useQuery({ queryKey: leaveKeys.mine(), queryFn: doctorsApi.listMyLeaves });
}

/** A `useMutation`, not a `useQuery`, on purpose - a preview is something the doctor asks for by
 *  picking a date and pressing a button, not something that should ever run just because a
 *  component rendered. */
export function useLeavePreview() {
  return useMutation({
    mutationFn: (leaveDate: string) => doctorsApi.previewLeaveImpact(leaveDate),
  });
}

export function useAddLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ leaveDate, reason }: { leaveDate: string; reason?: string }) =>
      doctorsApi.addMyLeave(leaveDate, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.mine() });
      // Marking a leave day can cancel appointments on it - every cached schedule page is now
      // potentially stale, the same reason submitting notes drops them all too.
      void queryClient.invalidateQueries({ queryKey: appointmentKeys.all });
    },
  });
}

export function useDeleteLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (leaveId: string) => doctorsApi.deleteMyLeave(leaveId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.mine() });
    },
  });
}
