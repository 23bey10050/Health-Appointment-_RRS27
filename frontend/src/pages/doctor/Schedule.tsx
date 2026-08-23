import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch } from "@/lib/api";
import type { Appointment } from "@/lib/types";

const STATUS_COLOR: Record<string, string> = {
  held: "bg-amber-100 text-amber-700",
  confirmed: "bg-brand-100 text-brand-700",
  cancelled: "bg-slate-100 text-slate-500",
  completed: "bg-green-100 text-green-700",
  no_show: "bg-slate-100 text-slate-500",
  rescheduled: "bg-amber-100 text-amber-700",
};

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export default function Schedule() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<Appointment[]>("/api/v1/appointments")
      .then(setAppointments)
      .finally(() => setLoading(false));
  }, []);

  const now = new Date();
  const active = appointments.filter((a) => a.status === "confirmed" || a.status === "held");
  const today = active.filter((a) => isSameDay(new Date(a.start_at), now));
  const upcoming = active.filter((a) => !isSameDay(new Date(a.start_at), now) && new Date(a.start_at) > now);
  const past = appointments.filter((a) => a.status === "completed" || a.status === "no_show");

  function Row({ a }: { a: Appointment }) {
    return (
      <Link
        to={`/doctor/appointments/${a.id}`}
        className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-brand-400 hover:shadow-sm"
      >
        <div className="flex items-center justify-between">
          <div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[a.status]}`}>
              {a.status}
            </span>
            <p className="mt-1 font-medium text-slate-900">{a.patient_name}</p>
          </div>
          <p className="text-sm text-slate-500">
            {new Date(a.start_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
      </Link>
    );
  }

  return (
    <PortalShell>
      <h1 className="text-2xl font-semibold text-slate-900">Schedule</h1>

      {loading && <p className="mt-4 text-sm text-slate-500">Loading...</p>}

      {!loading && (
        <div className="mt-6 space-y-8">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Today ({today.length})
            </h2>
            <div className="mt-3 space-y-2">
              {today.length === 0 && <p className="text-sm text-slate-400">No appointments today.</p>}
              {today.map((a) => (
                <Row key={a.id} a={a} />
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Upcoming</h2>
            <div className="mt-3 space-y-2">
              {upcoming.length === 0 && <p className="text-sm text-slate-400">Nothing else scheduled.</p>}
              {upcoming.map((a) => (
                <Row key={a.id} a={a} />
              ))}
            </div>
          </div>

          {past.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Past</h2>
              <div className="mt-3 space-y-2">
                {past.slice(0, 20).map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </PortalShell>
  );
}
