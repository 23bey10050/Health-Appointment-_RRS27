import type { ListDoctorsQuery } from '@health/contracts';
import { useQuery } from '@tanstack/react-query';

import * as doctorsApi from '../../lib/api/doctors.js';

export const doctorKeys = {
  all: ['doctors'] as const,
  list: (query: Partial<ListDoctorsQuery>) => [...doctorKeys.all, 'list', query] as const,
  availability: (doctorId: string, from: string, to: string) =>
    [...doctorKeys.all, doctorId, 'availability', from, to] as const,
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
