import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type { Appointment } from "@/lib/types";

const STATUS_LABEL: Record<string, string> = {
  held: "Held",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
  rescheduled: "Rescheduled",
};

const STATUS_COLOR: Record<string, string> = {
  held: "bg-amber-100 text-amber-700",
  confirmed: "bg-brand-100 text-brand-700",
  cancelled: "bg-slate-100 text-slate-500",
  completed: "bg-green-100 text-green-700",
  no_show: "bg-slate-100 text-slate-500",
  rescheduled: "bg-amber-100 text-amber-700",
};

export default function MyAppointments() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Appointment[]>("/api/v1/appointments");
      setAppointments(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCancel(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/v1/appointments/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "patient_cancelled" }),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel this appointment.");
    } finally {
      setBusyId(null);
    }
  }

  const upcoming = appointments.filter((a) => a.status === "confirmed" || a.status === "held");
  const past = appointments.filter((a) => a.status !== "confirmed" && a.status !== "held");

  return (
    <PortalShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">My appointments</h1>
        <Link to="/patient/book" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Book new appointment
        </Link>
      </div>

      {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}
      {loading && <p className="mt-4 text-sm text-slate-500">Loading...</p>}

      {!loading && upcoming.length === 0 && past.length === 0 && (
        <p className="mt-6 text-sm text-slate-500">You have no appointments yet.</p>
      )}

      {upcoming.length > 0 && (
        <div className="mt-6 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Upcoming</h2>
          {upcoming.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[a.status]}`}>
                    {STATUS_LABEL[a.status]}
                  </span>
                  <p className="mt-1 font-medium text-slate-900">
                    {a.doctor_name ? `${a.doctor_name} -- ` : ""}
                    {new Date(a.start_at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
                  </p>
                  {a.reason_text && <p className="text-sm text-slate-500">{a.reason_text}</p>}
                </div>
                {a.status === "confirmed" && (
                  <button
                    onClick={() => handleCancel(a.id)}
                    disabled={busyId === a.id}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="mt-6 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Past</h2>
          {past.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-200 bg-white p-4 opacity-75">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[a.status]}`}>
                {STATUS_LABEL[a.status]}
              </span>
              <p className="mt-1 text-sm text-slate-700">
                {a.doctor_name ? `${a.doctor_name} -- ` : ""}
                {new Date(a.start_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </p>
              {a.status === "completed" && (
                <Link to={`/patient/appointments/${a.id}`} className="mt-1 inline-block text-xs text-brand-600 hover:underline">
                  View visit summary
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </PortalShell>
  );
}
