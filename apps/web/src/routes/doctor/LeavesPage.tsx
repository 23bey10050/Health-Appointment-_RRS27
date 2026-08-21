import { useState } from 'react';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { Input } from '../../components/Input.js';
import {
  useAddLeave,
  useDeleteLeave,
  useLeavePreview,
  useMyLeaves,
} from '../../features/doctors/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { formatCalendarDate, todayAsDateString } from '../../lib/format.js';

/**
 * Preview, then confirm - a doctor sees exactly how many booked patients a day off would bump
 * before anything actually happens, the same warning-before-committing shape the plan asks for.
 * Picking a different date throws the old preview away rather than leaving a stale count on
 * screen that no longer describes the date in the box.
 */
function MarkLeaveForm() {
  const [leaveDate, setLeaveDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const leavePreview = useLeavePreview();
  const addLeave = useAddLeave();

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

  return (
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
          placeholder="Personal leave, conference, etc."
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
  );
}

function LeaveList() {
  const { data: leaves, isLoading, isError, refetch } = useMyLeaves();
  const deleteLeave = useDeleteLeave();
  const [deleteError, setDeleteError] = useState<string | undefined>();

  async function handleDelete(leaveId: string): Promise<void> {
    setDeleteError(undefined);
    try {
      await deleteLeave.mutateAsync(leaveId);
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : 'Could not remove this day off.');
    }
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-slate-700">Your days off</h2>

      <ColdStartNotice isLoading={isLoading} />
      {isError && (
        <Alert variant="error">
          Could not load your days off.{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            Try again
          </button>
        </Alert>
      )}
      {deleteError && <Alert variant="error">{deleteError}</Alert>}

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
                <p className="font-medium text-slate-900">{formatCalendarDate(leave.leaveDate)}</p>
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
  );
}

export function Component() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Days off</h1>
      <div className="flex flex-col gap-6">
        <MarkLeaveForm />
        <LeaveList />
      </div>
    </div>
  );
}
