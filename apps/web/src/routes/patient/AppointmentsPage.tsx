import type { Appointment } from '@health/contracts';
import { Link } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { useMyAppointments } from '../../features/appointments/queries.js';
import { formatDateTime } from '../../lib/format.js';

const STATUS_STYLES: Record<Appointment['status'], string> = {
  confirmed: 'bg-brand-100 text-brand-800',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-slate-200 text-slate-600',
  no_show: 'bg-amber-100 text-amber-800',
};

function StatusBadge({ status }: { status: Appointment['status'] }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

export function Component() {
  const { data: appointments, isLoading, isError, error, refetch } = useMyAppointments();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">My appointments</h1>
        <Link to="/search">
          <Button>Book a new appointment</Button>
        </Link>
      </div>

      <ColdStartNotice isLoading={isLoading} />

      {isError && (
        <Alert variant="error">
          Could not load your appointments.{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            Try again
          </button>
          {error instanceof Error && <span className="sr-only"> ({error.message})</span>}
        </Alert>
      )}

      {!isLoading && !isError && appointments && appointments.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 px-6 py-10 text-center">
          <p className="mb-4 text-slate-600">You have no appointments yet.</p>
          <Link to="/search">
            <Button>Find a doctor</Button>
          </Link>
        </div>
      )}

      {appointments && appointments.length > 0 && (
        <ul className="flex flex-col gap-3">
          {appointments.map((appointment) => (
            <li key={appointment.id}>
              <Link
                to={`/appointments/${appointment.id}`}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3 hover:border-brand-300 hover:shadow-sm"
              >
                <div>
                  <p className="font-medium text-slate-900">{appointment.doctorName}</p>
                  <p className="text-sm text-slate-600">{formatDateTime(appointment.start)}</p>
                </div>
                <StatusBadge status={appointment.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
