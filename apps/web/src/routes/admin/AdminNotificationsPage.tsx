import type { DeadLetterNotification } from '@health/contracts';
import { useState } from 'react';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import {
  useDeadLetters,
  useNotificationSummary,
  useRetryNotification,
} from '../../features/notifications/queries.js';
import { ApiError } from '../../lib/api-client.js';
import { formatDateTime } from '../../lib/format.js';

const SUMMARY_LABELS: Record<string, string> = {
  queued: 'Queued',
  sent: 'Sent',
  failed: 'Retrying',
  dead_letter: 'Dead-lettered',
};

function SummaryStrip() {
  const { data, isLoading, isError } = useNotificationSummary();

  if (isLoading || isError || !data) {
    return null;
  }

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Object.entries(SUMMARY_LABELS).map(([key, label]) => (
        <div key={key} className="rounded-md border border-slate-200 bg-white p-4 text-center">
          <p className="text-2xl font-semibold text-slate-900">{data[key as keyof typeof data]}</p>
          <p className="text-sm text-slate-600">{label}</p>
        </div>
      ))}
    </div>
  );
}

function DeadLetterRow({ row }: { row: DeadLetterNotification }) {
  const [error, setError] = useState<string | undefined>();
  const retry = useRetryNotification();

  async function handleRetry(): Promise<void> {
    setError(undefined);
    try {
      await retry.mutateAsync(row.id);
    } catch (retryError) {
      setError(retryError instanceof ApiError ? retryError.message : 'Could not retry this one.');
    }
  }

  return (
    <li className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-slate-900">
            {row.channel} &middot; {row.type.replace('_', ' ')}
          </p>
          <p className="text-sm text-slate-600">
            {row.attempts} attempts &middot; queued {formatDateTime(row.createdAt)}
          </p>
          {row.lastError && <p className="mt-1 text-sm text-red-700">{row.lastError}</p>}
        </div>
        <Button variant="secondary" isLoading={retry.isPending} onClick={() => void handleRetry()}>
          Retry
        </Button>
      </div>
      {error && (
        <div className="mt-2">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
    </li>
  );
}

export function Component() {
  const { data: deadLetters, isLoading, isError, refetch } = useDeadLetters();

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Notification health</h1>

      <SummaryStrip />

      <h2 className="mb-3 text-sm font-semibold text-slate-700">Dead-lettered notifications</h2>
      <ColdStartNotice isLoading={isLoading} />
      {isError && (
        <Alert variant="error">
          Could not load dead-lettered notifications.{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            Try again
          </button>
        </Alert>
      )}

      {!isLoading && !isError && deadLetters && deadLetters.length === 0 && (
        <p className="text-sm text-slate-600">Nothing stuck right now.</p>
      )}

      {deadLetters && deadLetters.length > 0 && (
        <ul className="flex flex-col gap-3">
          {deadLetters.map((row) => (
            <DeadLetterRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
