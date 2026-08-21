import { useState } from 'react';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { Input } from '../../components/Input.js';
import { useAuditLog } from '../../features/audit/queries.js';
import { formatDateTime } from '../../lib/format.js';

const PAGE_SIZE = 25;

export function Component() {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useAuditLog({
    action: action.trim() || undefined,
    entityType: entityType.trim() || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  function handleFilterChange(setter: (value: string) => void, value: string): void {
    setter(value);
    setPage(1);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Audit log</h1>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 sm:max-w-lg">
        <Input
          label="Filter by action"
          placeholder="e.g. appointment_booked"
          value={action}
          onChange={(event) => handleFilterChange(setAction, event.target.value)}
        />
        <Input
          label="Filter by entity type"
          placeholder="e.g. appointment"
          value={entityType}
          onChange={(event) => handleFilterChange(setEntityType, event.target.value)}
        />
      </div>

      <ColdStartNotice isLoading={isLoading} />
      {isError && (
        <Alert variant="error">
          Could not load the audit log.{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            Try again
          </button>
        </Alert>
      )}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <p className="text-sm text-slate-600">No entries match these filters.</p>
      )}

      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Who</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Entity</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap text-slate-600">
                    {formatDateTime(entry.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-slate-800">{entry.actorName ?? 'system'}</td>
                  <td className="px-4 py-2 font-medium text-slate-900">{entry.action}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {entry.entityType}
                    {entry.entityId && (
                      <span className="text-slate-400"> &middot; {entry.entityId.slice(0, 8)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="secondary"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <p className="text-sm text-slate-600">
            Page {page} of {totalPages}
          </p>
          <Button
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
