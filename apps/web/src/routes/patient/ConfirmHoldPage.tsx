import { zodResolver } from '@hookform/resolvers/zod';
import { confirmRequestSchema, type ConfirmRequest, type HoldResponse } from '@health/contracts';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate, useParams, type Location } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { useConfirmHold } from '../../features/appointments/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { formatCountdown, formatDateTime, secondsUntil } from '../../lib/format.js';

export function Component() {
  const { holdId } = useParams<{ holdId: string }>();
  const location = useLocation() as Location<HoldResponse | undefined>;
  const navigate = useNavigate();
  const hold = location.state;

  const [secondsLeft, setSecondsLeft] = useState(() => (hold ? secondsUntil(hold.expiresAt) : 0));
  const [formError, setFormError] = useState<string | undefined>();
  const confirmHold = useConfirmHold();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConfirmRequest>({ resolver: zodResolver(confirmRequestSchema) });

  useEffect(() => {
    if (!hold) return;
    const timer = setInterval(() => setSecondsLeft(secondsUntil(hold.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [hold]);

  // A page reload loses the router state a hold's own details live in - there is no endpoint to
  // fetch a hold back by id, since a hold is meant to be ephemeral. Sending the visitor back to
  // pick a slot again is the honest recovery, not a crash on `hold.start`.
  if (!hold || !holdId) {
    return (
      <div className="mx-auto max-w-md text-center">
        <Alert variant="info">This booking session was lost. Please choose a slot again.</Alert>
        <Link to="/search" className="mt-4 inline-block font-medium text-brand-700 hover:underline">
          Find a doctor
        </Link>
      </div>
    );
  }

  const expired = secondsLeft <= 0;

  const onSubmit = handleSubmit(async (data) => {
    setFormError(undefined);
    try {
      const appointment = await confirmHold.mutateAsync({ holdId, symptoms: data.symptoms });
      await navigate(`/appointments/${appointment.id}?booked=true`, { replace: true });
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not confirm this appointment. Please try again.',
      );
    }
  });

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-2 text-2xl font-semibold text-slate-900">Confirm your appointment</h1>
      <p className="mb-6 text-slate-600">{formatDateTime(hold.start)}</p>

      {expired ? (
        <div>
          <Alert variant="error">
            This hold has expired. Please choose a slot again - nobody else has necessarily taken
            it, but it is no longer reserved for you.
          </Alert>
          <Link
            to="/search"
            className="mt-4 inline-block font-medium text-brand-700 hover:underline"
          >
            Find a doctor
          </Link>
        </div>
      ) : (
        <>
          <p role="timer" aria-live="polite" className="mb-6 text-sm text-slate-500">
            This slot is held for you for{' '}
            <span className="font-mono font-medium text-slate-800">
              {formatCountdown(secondsLeft)}
            </span>
          </p>

          <form
            onSubmit={(event) => void onSubmit(event)}
            noValidate
            className="flex flex-col gap-4"
          >
            {formError && <Alert variant="error">{formError}</Alert>}
            <div className="flex flex-col gap-1">
              <label htmlFor="symptoms" className="text-sm font-medium text-slate-700">
                What&apos;s bringing you in?
              </label>
              <textarea
                id="symptoms"
                rows={5}
                aria-invalid={errors.symptoms ? true : undefined}
                aria-describedby={errors.symptoms ? 'symptoms-error' : undefined}
                className={`rounded-md border px-3 py-2 text-sm focus-visible:ring-1 ${errors.symptoms ? 'border-red-400' : 'border-slate-300'}`}
                placeholder="Describe your symptoms in your own words - when they started, how they feel, anything you want the doctor to know before you arrive."
                {...register('symptoms')}
              />
              {errors.symptoms && (
                <p id="symptoms-error" role="alert" className="text-sm text-red-700">
                  {errors.symptoms.message}
                </p>
              )}
            </div>
            <Button type="submit" isLoading={isSubmitting}>
              Confirm appointment
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
