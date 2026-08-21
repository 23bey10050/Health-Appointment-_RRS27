import { zodResolver } from '@hookform/resolvers/zod';
import {
  prescriptionItemSchema,
  submitNotesRequestSchema,
  type Appointment,
  type UrgencyLevel,
} from '@health/contracts';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { useParams } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { Input } from '../../components/Input.js';
import { useAppointment, useSubmitNotes } from '../../features/appointments/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { formatDateTime } from '../../lib/format.js';

const URGENCY_STYLES: Record<UrgencyLevel, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-red-100 text-red-800',
};

function UrgencyBadge({ urgency }: { urgency: UrgencyLevel }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${URGENCY_STYLES[urgency]}`}
    >
      {urgency} urgency
    </span>
  );
}

/** Everything the pre-visit AI call (or, failing that, its template floor) hands the doctor before
 *  they ever walk in - the same three fields `previsitSummarySchema` promises, laid out so the
 *  most time-sensitive one, urgency, is the first thing a busy doctor's eye lands on. */
function PrevisitBrief({ appointment }: { appointment: Appointment }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Pre-visit brief</h2>
        {appointment.aiPrevisitStatus === 'ready' && appointment.aiUrgency && (
          <UrgencyBadge urgency={appointment.aiUrgency} />
        )}
      </div>

      {appointment.aiPrevisitStatus === 'pending' && (
        <p className="text-sm text-slate-500">Preparing the brief&hellip;</p>
      )}

      {appointment.aiChiefComplaint && (
        <p className="mb-3 text-sm font-medium text-slate-800">{appointment.aiChiefComplaint}</p>
      )}

      {appointment.aiSuggestedQuestions && appointment.aiSuggestedQuestions.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Worth asking
          </p>
          <ul className="list-disc pl-5 text-sm text-slate-600">
            {appointment.aiSuggestedQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      )}

      {appointment.symptoms && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            What the patient said
          </p>
          <p className="text-sm text-slate-600">{appointment.symptoms}</p>
        </div>
      )}
    </div>
  );
}

/**
 * `submitNotesRequestSchema` itself defaults a missing prescription to `[]` server-side, which is
 * exactly what makes it the wrong schema to hand `zodResolver` here - a Zod default splits a
 * schema's input type (prescription optional) from its output type (prescription always an
 * array), and react-hook-form wants one single shape for both. This form always seeds
 * `prescription: []` itself, so the field is never actually missing; requiring it outright sidesteps
 * the input/output mismatch instead of fighting it.
 */
const notesFormSchema = submitNotesRequestSchema.extend({
  prescription: z.array(prescriptionItemSchema).max(20),
});
type NotesFormValues = z.infer<typeof notesFormSchema>;

function NotesForm({ appointmentId }: { appointmentId: string }) {
  const [formError, setFormError] = useState<string | undefined>();
  const submitNotes = useSubmitNotes();

  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NotesFormValues>({
    resolver: zodResolver(notesFormSchema),
    defaultValues: { doctorNotes: '', prescription: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'prescription' });

  const onSubmit = handleSubmit(async (data) => {
    setFormError(undefined);
    try {
      await submitNotes.mutateAsync({
        id: appointmentId,
        doctorNotes: data.doctorNotes,
        prescription: data.prescription,
      });
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not save these notes. Please try again.',
      );
    }
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-slate-700">Complete the visit</h2>
      {formError && <Alert variant="error">{formError}</Alert>}

      <div className="flex flex-col gap-1">
        <label htmlFor="doctorNotes" className="text-sm font-medium text-slate-700">
          Visit notes
        </label>
        <textarea
          id="doctorNotes"
          rows={5}
          aria-invalid={errors.doctorNotes ? true : undefined}
          aria-describedby={errors.doctorNotes ? 'doctorNotes-error' : undefined}
          className={`rounded-md border px-3 py-2 text-sm focus-visible:ring-1 ${errors.doctorNotes ? 'border-red-400' : 'border-slate-300'}`}
          placeholder="What you found, your diagnosis, anything the patient should remember."
          {...register('doctorNotes')}
        />
        {errors.doctorNotes && (
          <p id="doctorNotes-error" role="alert" className="text-sm text-red-700">
            {errors.doctorNotes.message}
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">Prescription</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => append({ drug: '', dosage: '', timesPerDay: 1, durationDays: 5 })}
          >
            Add medicine
          </Button>
        </div>

        {fields.length === 0 && (
          <p className="text-sm text-slate-500">No medication for this visit.</p>
        )}

        <div className="flex flex-col gap-3">
          {fields.map((field, index) => (
            <div
              key={field.id}
              className="grid grid-cols-2 gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-4"
            >
              <Input
                label="Drug"
                error={errors.prescription?.[index]?.drug?.message}
                {...register(`prescription.${index}.drug`)}
              />
              <Input
                label="Dosage"
                error={errors.prescription?.[index]?.dosage?.message}
                {...register(`prescription.${index}.dosage`)}
              />
              <Input
                label="Times per day"
                type="number"
                min={1}
                max={12}
                error={errors.prescription?.[index]?.timesPerDay?.message}
                {...register(`prescription.${index}.timesPerDay`, { valueAsNumber: true })}
              />
              <Input
                label="Days"
                type="number"
                min={1}
                max={365}
                error={errors.prescription?.[index]?.durationDays?.message}
                {...register(`prescription.${index}.durationDays`, { valueAsNumber: true })}
              />
              <div className="col-span-2 sm:col-span-4">
                <Input
                  label="Instructions (optional)"
                  error={errors.prescription?.[index]?.instructions?.message}
                  {...register(`prescription.${index}.instructions`)}
                />
              </div>
              <div className="col-span-2 sm:col-span-4">
                <Button type="button" variant="danger" onClick={() => remove(index)}>
                  Remove this medicine
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Button type="submit" isLoading={isSubmitting}>
        Complete visit
      </Button>
    </form>
  );
}

function CompletedVisit({ appointment }: { appointment: Appointment }) {
  return (
    <div className="flex flex-col gap-4">
      {appointment.doctorNotes && (
        <div>
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Your notes</h2>
          <p className="text-sm text-slate-600">{appointment.doctorNotes}</p>
        </div>
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
    </div>
  );
}

export function Component() {
  const { id } = useParams<{ id: string }>();
  const { data: appointment, isLoading, isError } = useAppointment(id);

  return (
    <div className="mx-auto max-w-2xl">
      <ColdStartNotice isLoading={isLoading} />
      {isError && <Alert variant="error">Could not load this appointment.</Alert>}

      {appointment && (
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{appointment.patientName}</h1>
            <p className="text-slate-600">{formatDateTime(appointment.start)}</p>
          </div>

          <PrevisitBrief appointment={appointment} />

          {appointment.status === 'confirmed' && <NotesForm appointmentId={appointment.id} />}
          {appointment.status === 'completed' && <CompletedVisit appointment={appointment} />}
          {(appointment.status === 'cancelled' || appointment.status === 'no_show') && (
            <Alert variant="info">
              This appointment is {appointment.status.replace('_', ' ')}.
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
