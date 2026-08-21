import type { Appointment, UrgencyLevel } from '@health/contracts';
import { useState } from 'react';
import { Link } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { useMySchedule } from '../../features/appointments/queries.js';
import { addDays, formatCalendarDate, formatTime, todayAsDateString } from '../../lib/format.js';

const STATUS_STYLES: Record<Appointment['status'], string> = {
  confirmed: 'bg-brand-100 text-brand-800',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-slate-200 text-slate-600',
  no_show: 'bg-amber-100 text-amber-800',
};

const URGENCY_STYLES: Record<UrgencyLevel, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-red-100 text-red-800',
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

function UrgencyBadge({ urgency }: { urgency: UrgencyLevel }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${URGENCY_STYLES[urgency]}`}
    >
      {urgency} urgency
    </span>
  );
}

export function Component() {
  const [date, setDate] = useState(todayAsDateString);
  const { data: appointments, isLoading, isError, refetch } = useMySchedule(date, date);
  const isToday = date === todayAsDateString();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Your schedule</h1>
        <Link to="/doctor/leaves">
          <Button variant="secondary">Manage days off</Button>
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => setDate((current) => addDays(current, -1))}>
          Previous day
        </Button>
        <p className="min-w-[14rem] text-center text-sm font-medium text-slate-700">
          {formatCalendarDate(date)}
        </p>
        <Button variant="secondary" onClick={() => setDate((current) => addDays(current, 1))}>
          Next day
        </Button>
        {!isToday && (
          <button
            type="button"
            onClick={() => setDate(todayAsDateString())}
            className="text-sm font-medium text-brand-700 hover:underline"
          >
            Back to today
          </button>
        )}
      </div>

      <ColdStartNotice isLoading={isLoading} />

      {isError && (
        <Alert variant="error">
          Could not load your schedule.{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            Try again
          </button>
        </Alert>
      )}

      {!isLoading && !isError && appointments && appointments.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 px-6 py-10 text-center">
          <p className="text-slate-600">Nothing on the schedule for this day.</p>
        </div>
      )}

      {appointments && appointments.length > 0 && (
        <ul className="flex flex-col gap-3">
          {appointments.map((appointment) => (
            <li key={appointment.id}>
              <Link
                to={`/doctor/appointments/${appointment.id}`}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3 hover:border-brand-300 hover:shadow-sm"
              >
                <div>
                  <p className="font-medium text-slate-900">{appointment.patientName}</p>
                  <p className="text-sm text-slate-600">{formatTime(appointment.start)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {appointment.aiPrevisitStatus === 'ready' && appointment.aiUrgency && (
                    <UrgencyBadge urgency={appointment.aiUrgency} />
                  )}
                  <StatusBadge status={appointment.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
