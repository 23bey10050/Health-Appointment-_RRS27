import type {
  CreateDoctorRequest,
  ListDoctorsQuery,
  UpdateDoctorRequest,
  WorkingHourInput,
} from '@health/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { appointmentKeys } from '../appointments/queries.js';

import * as doctorsApi from '../../lib/api/doctors.js';

export const doctorKeys = {
  all: ['doctors'] as const,
  list: (query: Partial<ListDoctorsQuery>) => [...doctorKeys.all, 'list', query] as const,
  adminList: (query: Partial<ListDoctorsQuery>) =>
    [...doctorKeys.all, 'admin-list', query] as const,
  detail: (doctorId: string) => [...doctorKeys.all, 'detail', doctorId] as const,
  availability: (doctorId: string, from: string, to: string) =>
    [...doctorKeys.all, doctorId, 'availability', from, to] as const,
};

export const leaveKeys = {
  all: ['leaves'] as const,
  mine: () => [...leaveKeys.all, 'mine'] as const,
  forDoctor: (doctorId: string) => [...leaveKeys.all, doctorId] as const,
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

export function useDoctor(doctorId: string | undefined) {
  return useQuery({
    queryKey: doctorKeys.detail(doctorId ?? ''),
    queryFn: () => doctorsApi.getDoctor(doctorId!),
    enabled: doctorId !== undefined,
  });
}

export function useAdminDoctors(query: Partial<ListDoctorsQuery> = {}) {
  return useQuery({
    queryKey: doctorKeys.adminList(query),
    queryFn: () => doctorsApi.listDoctorsForAdmin(query),
  });
}

export function useCreateDoctor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDoctorRequest) => doctorsApi.createDoctor(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: doctorKeys.all });
    },
  });
}

export function useUpdateDoctor(doctorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDoctorRequest) => doctorsApi.updateDoctor(doctorId, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(doctorKeys.detail(doctorId), updated);
      void queryClient.invalidateQueries({ queryKey: doctorKeys.all });
    },
  });
}

export function useAddWorkingHour(doctorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkingHourInput) => doctorsApi.addWorkingHour(doctorId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: doctorKeys.detail(doctorId) });
    },
  });
}

export function useDeleteWorkingHour(doctorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workingHourId: string) => doctorsApi.deleteWorkingHour(doctorId, workingHourId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: doctorKeys.detail(doctorId) });
    },
  });
}

export function useDoctorLeaves(doctorId: string) {
  return useQuery({
    queryKey: leaveKeys.forDoctor(doctorId),
    queryFn: () => doctorsApi.listLeavesForDoctor(doctorId),
  });
}

/** Same on-demand-only shape as `useLeavePreview` above, parameterized by doctor since an admin
 *  previews a day off on someone else's calendar, never their own. */
export function useDoctorLeavePreview(doctorId: string) {
  return useMutation({
    mutationFn: (leaveDate: string) => doctorsApi.previewLeaveImpactForDoctor(doctorId, leaveDate),
  });
}

export function useAddDoctorLeave(doctorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ leaveDate, reason }: { leaveDate: string; reason?: string }) =>
      doctorsApi.addLeaveForDoctor(doctorId, leaveDate, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.forDoctor(doctorId) });
      void queryClient.invalidateQueries({ queryKey: appointmentKeys.all });
    },
  });
}

export function useDeleteDoctorLeave(doctorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (leaveId: string) => doctorsApi.deleteLeaveForDoctor(doctorId, leaveId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.forDoctor(doctorId) });
    },
  });
}
