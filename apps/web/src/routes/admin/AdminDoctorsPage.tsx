import { zodResolver } from '@hookform/resolvers/zod';
import { createDoctorRequestSchema, type CreateDoctorRequest } from '@health/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { Input } from '../../components/Input.js';
import { useAdminDoctors, useCreateDoctor } from '../../features/doctors/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { browserTimezone } from '../../lib/format.js';

function CreateDoctorForm({ onCreated }: { onCreated: () => void }) {
  const [formError, setFormError] = useState<string | undefined>();
  const createDoctor = useCreateDoctor();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateDoctorRequest>({ resolver: zodResolver(createDoctorRequestSchema) });

  const onSubmit = handleSubmit(async (data) => {
    setFormError(undefined);
    try {
      await createDoctor.mutateAsync({ ...data, timezone: data.timezone ?? browserTimezone() });
      reset();
      onCreated();
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not create this doctor. Please try again.',
      );
    }
  });

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="flex flex-col gap-4 rounded-md border border-slate-200 bg-white p-4"
    >
      {formError && <Alert variant="error">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Full name" error={errors.fullName?.message} {...register('fullName')} />
        <Input
          label="Specialization"
          error={errors.specialization?.message}
          {...register('specialization')}
        />
        <Input label="Email" type="email" error={errors.email?.message} {...register('email')} />
        <Input
          label="Password"
          type="password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Input label="Phone (optional)" error={errors.phone?.message} {...register('phone')} />
        <Input
          label="Consultation fee (optional)"
          type="number"
          step="0.01"
          min={0}
          error={errors.consultationFee?.message}
          {...register('consultationFee', { valueAsNumber: true })}
        />
      </div>
      <p className="text-xs text-slate-500">
        Shifts and days off can be added from the doctor's own page once the account exists.
      </p>
      <Button type="submit" isLoading={isSubmitting} className="self-start">
        Create doctor
      </Button>
    </form>
  );
}

export function Component() {
  const [specialization, setSpecialization] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const { data, isLoading, isError, refetch } = useAdminDoctors(
    specialization.trim() ? { specialization: specialization.trim() } : {},
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Doctors</h1>
        <Button variant="secondary" onClick={() => setShowCreateForm((open) => !open)}>
          {showCreateForm ? 'Close' : 'Add doctor'}
        </Button>
      </div>

      {showCreateForm && (
        <div className="mb-6">
          <CreateDoctorForm
            onCreated={() => {
              setShowCreateForm(false);
              void refetch();
            }}
          />
        </div>
      )}

      <div className="mb-6 max-w-sm">
        <Input
          label="Filter by specialization"
          placeholder="e.g. Cardiology"
          value={specialization}
          onChange={(event) => setSpecialization(event.target.value)}
        />
      </div>

      <ColdStartNotice isLoading={isLoading} />
      {isError && (
        <Alert variant="error">Could not load the doctor roster. Please try again.</Alert>
      )}

      {data && data.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.items.map((doctor) => (
            <li key={doctor.id}>
              <Link
                to={`/admin/doctors/${doctor.id}`}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3 hover:border-brand-300 hover:shadow-sm"
              >
                <div>
                  <p className="font-medium text-slate-900">{doctor.fullName}</p>
                  <p className="text-sm text-slate-600">{doctor.specialization}</p>
                </div>
                {!doctor.isActive && (
                  <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                    Deactivated
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <p className="text-sm text-slate-600">No doctors match that search.</p>
      )}
    </div>
  );
}
