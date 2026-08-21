import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { useAvailability } from '../../features/doctors/queries.js';
import { useHoldSlot } from '../../features/appointments/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { formatDate, formatTime, localDateKey } from '../../lib/format.js';

const VISIBLE_DAYS = 7;

function todayAsDateString(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat('en-CA').format(date);
}

export function Component() {
  const { doctorId } = useParams<{ doctorId: string }>();
  const navigate = useNavigate();
  const [from] = useState(todayAsDateString);
  const to = useMemo(() => addDays(from, VISIBLE_DAYS - 1), [from]);

  const { data, isLoading, isError } = useAvailability(doctorId!, from, to);
  const holdSlot = useHoldSlot();
  const [holdError, setHoldError] = useState<string | undefined>();

  const slotsByDay = useMemo(() => {
    const groups = new Map<string, { start: string; end: string }[]>();
    for (const slot of data?.slots ?? []) {
      const key = localDateKey(slot.start);
      const existing = groups.get(key) ?? [];
      existing.push(slot);
      groups.set(key, existing);
    }
    return groups;
  }, [data]);

  async function handlePickSlot(start: string): Promise<void> {
    setHoldError(undefined);
    try {
      const hold = await holdSlot.mutateAsync({ doctorId: doctorId!, start });
      await navigate(`/hold/${hold.holdId}`, { state: hold });
    } catch (error) {
      setHoldError(
        error instanceof ApiError
          ? error.message
          : 'Could not hold that slot. Please try another one.',
      );
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Choose a time</h1>

      <ColdStartNotice isLoading={isLoading} />
      {isError && <Alert variant="error">Could not load this doctor&apos;s availability.</Alert>}
      {holdError && <Alert variant="error">{holdError}</Alert>}

      {!isLoading && data && data.slots.length === 0 && (
        <p className="text-slate-600">No open slots in the next {VISIBLE_DAYS} days.</p>
      )}

      <div className="flex flex-col gap-6">
        {[...slotsByDay.entries()].map(([day, slots]) => (
          <section key={day} aria-label={formatDate(slots[0]!.start)}>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">
              {formatDate(slots[0]!.start)}
            </h2>
            <div
              role="group"
              aria-label={`Available times on ${formatDate(slots[0]!.start)}`}
              className="flex flex-wrap gap-2"
            >
              {slots.map((slot) => (
                <button
                  key={slot.start}
                  type="button"
                  disabled={holdSlot.isPending}
                  onClick={() => void handlePickSlot(slot.start)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-brand-400 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {formatTime(slot.start)}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
