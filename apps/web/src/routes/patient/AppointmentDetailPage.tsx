import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { Input } from '../../components/Input.js';
import { useAppointment, useCancelAppointment } from '../../features/appointments/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { formatDateTime } from '../../lib/format.js';

function CancelAppointment({ appointmentId }: { appointmentId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const cancelAppointment = useCancelAppointment();

  if (!isOpen) {
    return (
      <Button variant="danger" onClick={() => setIsOpen(true)}>
        Cancel appointment
      </Button>
    );
  }

  async function handleCancel(): Promise<void> {
    setError(undefined);
    try {
      await cancelAppointment.mutateAsync({
        id: appointmentId,
        reason: reason.trim() || undefined,
      });
    } catch (cancelError) {
      setError(
        cancelError instanceof ApiError
          ? cancelError.message
          : 'Could not cancel this appointment. Please try again.',
      );
    }
  }

  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4">
      {error && (
        <div className="mb-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      <Input
        label="Reason (optional)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Feeling better, need to reschedule, etc."
      />
      <div className="mt-3 flex gap-2">
        <Button
          variant="danger"
          isLoading={cancelAppointment.isPending}
          onClick={() => void handleCancel()}
        >
          Yes, cancel it
        </Button>
        <Button
          variant="secondary"
          onClick={() => setIsOpen(false)}
          disabled={cancelAppointment.isPending}
        >
          Never mind
        </Button>
      </div>
    </div>
  );
}

export function Component() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const justBooked = searchParams.get('booked') === 'true';

  const { data: appointment, isLoading, isError } = useAppointment(id);

  return (
    <div className="mx-auto max-w-2xl">
      <ColdStartNotice isLoading={isLoading} />
      {isError && <Alert variant="error">Could not load this appointment.</Alert>}

      {appointment && (
        <div className="flex flex-col gap-6">
          {justBooked && appointment.status === 'confirmed' && (
            <Alert variant="success">
              Your appointment is confirmed. A confirmation email is on its way.
            </Alert>
          )}

          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{appointment.doctorName}</h1>
            <p className="text-slate-600">{formatDateTime(appointment.start)}</p>
            <span className="mt-2 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium capitalize text-slate-700">
              {appointment.status.replace('_', ' ')}
            </span>
          </div>

          {appointment.symptoms && (
            <div>
              <h2 className="mb-1 text-sm font-semibold text-slate-700">What you told us</h2>
              <p className="text-sm text-slate-600">{appointment.symptoms}</p>
            </div>
          )}

          {appointment.aiPostvisitStatus === 'pending' && (
            <Alert variant="info">Preparing your visit summary&hellip;</Alert>
          )}

          {appointment.aiPostvisitStatus === 'ready' && appointment.aiPostvisitSummary && (
            <div>
              <h2 className="mb-1 text-sm font-semibold text-slate-700">Visit summary</h2>
              <p className="text-sm text-slate-600">{appointment.aiPostvisitSummary}</p>
              {appointment.aiPostvisitSteps && appointment.aiPostvisitSteps.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-sm text-slate-600">
                  {appointment.aiPostvisitSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {appointment.aiPostvisitStatus === 'unavailable' && appointment.aiPostvisitSummary && (
            <Alert variant="info">{appointment.aiPostvisitSummary}</Alert>
          )}

          {appointment.prescription && appointment.prescription.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">Prescription</h2>
              <ul className="flex flex-col gap-2">
                {appointment.prescription.map((item) => (
                  <li
                    key={`${item.drug}-${item.dosage}`}
                    className="rounded-md border border-slate-200 bg-white p-3 text-sm"
                  >
                    <p className="font-medium text-slate-900">
                      {item.drug} &mdash; {item.dosage}
                    </p>
                    <p className="text-slate-600">
                      {item.timesPerDay}x daily for {item.durationDays} day
                      {item.durationDays === 1 ? '' : 's'}
                    </p>
                    {item.instructions && <p className="text-slate-500">{item.instructions}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {appointment.status === 'confirmed' && (
            <CancelAppointment appointmentId={appointment.id} />
          )}
        </div>
      )}
    </div>
  );
}
