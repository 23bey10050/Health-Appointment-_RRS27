import type { Doctor } from '@health/contracts';
import { useState } from 'react';
import { useParams } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { Input } from '../../components/Input.js';
import {
  useAddDoctorLeave,
  useAddWorkingHour,
  useDeleteDoctorLeave,
  useDeleteWorkingHour,
  useDoctor,
  useDoctorLeavePreview,
  useDoctorLeaves,
  useUpdateDoctor,
} from '../../features/doctors/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { formatCalendarDate, todayAsDateString } from '../../lib/format.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ProfileForm({ doctor }: { doctor: Doctor }) {
  const [specialization, setSpecialization] = useState(doctor.specialization);
  const [bio, setBio] = useState(doctor.bio ?? '');
  const [slotDurationMins, setSlotDurationMins] = useState(String(doctor.slotDurationMins));
  const [consultationFee, setConsultationFee] = useState(
    doctor.consultationFee !== null ? String(doctor.consultationFee) : '',
  );
  const [error, setError] = useState<string | undefined>();
  const updateDoctor = useUpdateDoctor(doctor.id);

  async function handleSave(): Promise<void> {
    setError(undefined);
    try {
      await updateDoctor.mutateAsync({
        specialization,
        bio: bio.trim() || null,
        slotDurationMins: Number(slotDurationMins),
        ...(consultationFee.trim() ? { consultationFee: Number(consultationFee) } : {}),
      });
    } catch (saveError) {
      setError(saveError instanceof ApiError ? saveError.message : 'Could not save these changes.');
    }
  }

  async function handleToggleActive(): Promise<void> {
    setError(undefined);
    try {
      await updateDoctor.mutateAsync({ isActive: !doctor.isActive });
    } catch (toggleError) {
      setError(
        toggleError instanceof ApiError
          ? toggleError.message
          : "Could not change this doctor's status.",
      );
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Profile</h2>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${doctor.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}
          >
            {doctor.isActive ? 'Active' : 'Deactivated'}
          </span>
          <Button
            variant="secondary"
            isLoading={updateDoctor.isPending}
            onClick={() => void handleToggleActive()}
          >
            {doctor.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Input
          label="Specialization"
          value={specialization}
          onChange={(event) => setSpecialization(event.target.value)}
        />
        <Input
          label="Slot length (minutes)"
          type="number"
          min={5}
          max={240}
          value={slotDurationMins}
          onChange={(event) => setSlotDurationMins(event.target.value)}
        />
        <Input
          label="Consultation fee (optional)"
          type="number"
          step="0.01"
          min={0}
          value={consultationFee}
          onChange={(event) => setConsultationFee(event.target.value)}
        />
      </div>

      <div className="mt-4 flex flex-col gap-1">
        <label htmlFor="doctor-bio" className="text-sm font-medium text-slate-700">
          Bio
        </label>
        <textarea
          id="doctor-bio"
          rows={3}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:ring-1"
          value={bio}
          onChange={(event) => setBio(event.target.value)}
        />
      </div>

      <Button className="mt-4" isLoading={updateDoctor.isPending} onClick={() => void handleSave()}>
        Save changes
      </Button>
    </div>
  );
}

function WorkingHoursEditor({ doctor }: { doctor: Doctor }) {
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [error, setError] = useState<string | undefined>();
  const addWorkingHour = useAddWorkingHour(doctor.id);
  const deleteWorkingHour = useDeleteWorkingHour(doctor.id);

  async function handleAdd(): Promise<void> {
    setError(undefined);
    try {
      await addWorkingHour.mutateAsync({ dayOfWeek, startTime, endTime });
    } catch (addError) {
      setError(addError instanceof ApiError ? addError.message : 'Could not add this shift.');
    }
  }

  async function handleRemove(workingHourId: string): Promise<void> {
    setError(undefined);
    try {
      await deleteWorkingHour.mutateAsync(workingHourId);
    } catch (removeError) {
      setError(
        removeError instanceof ApiError ? removeError.message : 'Could not remove this shift.',
      );
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">Working hours</h2>
      {error && (
        <div className="mb-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {doctor.workingHours.length === 0 && (
        <p className="mb-3 text-sm text-slate-500">No shifts yet.</p>
      )}
      <ul className="mb-4 flex flex-col gap-2">
        {doctor.workingHours.map((hour) => (
          <li
            key={hour.id}
            className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"
          >
            <span>
              {DAY_NAMES[hour.dayOfWeek]}, {hour.startTime.slice(0, 5)}&ndash;
              {hour.endTime.slice(0, 5)}
            </span>
            <Button
              variant="danger"
              isLoading={deleteWorkingHour.isPending}
              onClick={() => void handleRemove(hour.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="shift-day" className="text-sm font-medium text-slate-700">
            Day
          </label>
          <select
            id="shift-day"
            value={dayOfWeek}
            onChange={(event) => setDayOfWeek(Number(event.target.value))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            {DAY_NAMES.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <Input
          label="Start"
          type="time"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
        />
        <Input
          label="End"
          type="time"
          value={endTime}
          onChange={(event) => setEndTime(event.target.value)}
        />
        <Button
          variant="secondary"
          isLoading={addWorkingHour.isPending}
          onClick={() => void handleAdd()}
        >
          Add shift
        </Button>
      </div>
    </div>
  );
}

/** The same preview-then-confirm flow Phase 10 built for a doctor's own days off, parameterized by
 *  doctor id here instead of reading it off an access token - an admin is always acting on someone
 *  else's calendar, never their own. */
function DoctorLeaves({ doctorId }: { doctorId: string }) {
  const [leaveDate, setLeaveDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const leavePreview = useDoctorLeavePreview(doctorId);
  const addLeave = useAddDoctorLeave(doctorId);
  const { data: leaves, isLoading, isError, refetch } = useDoctorLeaves(doctorId);
  const deleteLeave = useDeleteDoctorLeave(doctorId);

  function handleDateChange(value: string): void {
    setLeaveDate(value);
    leavePreview.reset();
    setError(undefined);
  }

  async function handleCheckImpact(): Promise<void> {
    setError(undefined);
    try {
      await leavePreview.mutateAsync(leaveDate);
    } catch (previewError) {
      setError(
        previewError instanceof ApiError
          ? previewError.message
          : 'Could not check this date. Please try again.',
      );
    }
  }

  async function handleConfirm(): Promise<void> {
    setError(undefined);
    try {
      await addLeave.mutateAsync({ leaveDate, reason: reason.trim() || undefined });
      setLeaveDate('');
      setReason('');
      leavePreview.reset();
    } catch (addError) {
      setError(
        addError instanceof ApiError
          ? addError.message
          : 'Could not mark this day off. Please try again.',
      );
    }
  }

  async function handleDelete(leaveId: string): Promise<void> {
    setError(undefined);
    try {
      await deleteLeave.mutateAsync(leaveId);
    } catch (deleteError) {
      setError(
        deleteError instanceof ApiError ? deleteError.message : 'Could not remove this day off.',
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Mark a day off</h2>
        {error && (
          <div className="mb-3">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Input
            label="Date"
            type="date"
            min={todayAsDateString()}
            value={leaveDate}
            onChange={(event) => handleDateChange(event.target.value)}
          />
          <Input
            label="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!leaveDate}
            isLoading={leavePreview.isPending}
            onClick={() => void handleCheckImpact()}
          >
            Check impact
          </Button>
        </div>

        {leavePreview.isSuccess && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-800">
              {leavePreview.data.affectedAppointments === 0
                ? 'No confirmed appointments fall on this day - nothing will be cancelled.'
                : `${leavePreview.data.affectedAppointments} confirmed appointment${leavePreview.data.affectedAppointments === 1 ? '' : 's'} on this day will be cancelled, and each patient will be emailed.`}
            </p>
            <div className="mt-2">
              <Button isLoading={addLeave.isPending} onClick={() => void handleConfirm()}>
                Confirm and mark this day off
              </Button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Days off</h2>
        <ColdStartNotice isLoading={isLoading} />
        {isError && (
          <Alert variant="error">
            Could not load this doctor's days off.{' '}
            <button type="button" onClick={() => void refetch()} className="underline">
              Try again
            </button>
          </Alert>
        )}

        {!isLoading && !isError && leaves && leaves.length === 0 && (
          <p className="text-sm text-slate-600">Nothing marked yet.</p>
        )}

        {leaves && leaves.length > 0 && (
          <ul className="flex flex-col gap-2">
            {leaves.map((leave) => (
              <li
                key={leave.id}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3"
              >
                <div>
                  <p className="font-medium text-slate-900">
                    {formatCalendarDate(leave.leaveDate)}
                  </p>
                  {leave.reason && <p className="text-sm text-slate-600">{leave.reason}</p>}
                </div>
                <Button
                  variant="danger"
                  isLoading={deleteLeave.isPending}
                  onClick={() => void handleDelete(leave.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function Component() {
  const { id } = useParams<{ id: string }>();
  const { data: doctor, isLoading, isError } = useDoctor(id);

  return (
    <div className="mx-auto max-w-3xl">
      <ColdStartNotice isLoading={isLoading} />
      {isError && <Alert variant="error">Could not load this doctor.</Alert>}

      {doctor && (
        <div className="flex flex-col gap-6">
          <h1 className="text-2xl font-semibold text-slate-900">{doctor.fullName}</h1>
          <ProfileForm doctor={doctor} />
          <WorkingHoursEditor doctor={doctor} />
          <DoctorLeaves doctorId={doctor.id} />
        </div>
      )}
    </div>
  );
}
