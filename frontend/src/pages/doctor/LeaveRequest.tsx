import { useState } from "react";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { LeaveImpactPreview, LeaveOut } from "@/lib/types";

export default function LeaveRequest() {
  const { user } = useAuth();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<LeaveImpactPreview | null>(null);
  const [confirmed, setConfirmed] = useState<LeaveOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePreview() {
    if (!user || !startDate || !endDate) return;
    setBusy(true);
    setError(null);
    setConfirmed(null);
    try {
      const result = await apiFetch<LeaveImpactPreview>(`/api/v1/admin/doctors/${user.id}/leave`, {
        method: "POST",
        body: JSON.stringify({ start_date: startDate, end_date: endDate, reason: reason || null }),
      });
      setPreview(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not preview this leave request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!user || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<LeaveOut>(`/api/v1/admin/doctors/${user.id}/leave/confirm`, {
        method: "POST",
        body: JSON.stringify({ start_date: preview.start_date, end_date: preview.end_date, reason: reason || null }),
      });
      setConfirmed(result);
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not confirm this leave.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PortalShell>
      <h1 className="text-2xl font-semibold text-slate-900">Request leave</h1>
      <p className="mt-1 text-sm text-slate-500">
        Patients with an affected appointment are notified automatically and offered alternative slots.
      </p>

      {confirmed && (
        <div className="mt-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Leave confirmed from {confirmed.start_date} to {confirmed.end_date}.
        </div>
      )}

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-slate-700">Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setPreview(null);
              }}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">End date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value);
                setPreview(null);
              }}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Reason (optional)</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}

        {!preview && (
          <button
            onClick={handlePreview}
            disabled={busy || !startDate || !endDate}
            className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            Preview impact
          </button>
        )}

        {preview && (
          <div className="mt-4">
            {preview.affected_count === 0 ? (
              <p className="text-sm text-slate-600">No appointments are affected.</p>
            ) : (
              <div>
                <p className="text-sm font-medium text-amber-700">
                  {preview.affected_count} appointment{preview.affected_count === 1 ? "" : "s"} will be affected:
                </p>
                <ul className="mt-2 space-y-2">
                  {preview.affected.map((a) => (
                    <li key={a.appointment_id} className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                      <p className="font-medium text-slate-800">
                        {a.patient_name} -- {new Date(a.start_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                      </p>
                      {a.alternatives.length > 0 && (
                        <p className="mt-1 text-xs text-slate-600">
                          Alternatives offered:{" "}
                          {a.alternatives
                            .map((alt) => `${alt.doctor_name} @ ${new Date(alt.start_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`)
                            .join("; ")}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 flex gap-3">
              <button
                onClick={handleConfirm}
                disabled={busy}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? "Confirming..." : "Confirm leave"}
              </button>
              <button
                onClick={() => setPreview(null)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </PortalShell>
  );
}
