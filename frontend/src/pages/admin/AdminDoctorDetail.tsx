import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type { AdminDoctorOut, DoctorUpdate, Hospital, LeaveImpactPreview, LeaveOut, WorkingHours } from "@/lib/types";

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface DayRow {
  enabled: boolean;
  start_time: string;
  end_time: string;
}

function buildDayRows(hours: WorkingHours[]): DayRow[] {
  return Array.from({ length: 7 }, (_, weekday) => {
    const match = hours.find((h) => h.weekday === weekday);
    return match
      ? { enabled: true, start_time: match.start_time.slice(0, 5), end_time: match.end_time.slice(0, 5) }
      : { enabled: false, start_time: "09:00", end_time: "17:00" };
  });
}

export default function AdminDoctorDetail() {
  const { doctorId } = useParams<{ doctorId: string }>();
  const navigate = useNavigate();
  const [doctor, setDoctor] = useState<AdminDoctorOut | null>(null);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [form, setForm] = useState<DoctorUpdate>({});
  const [days, setDays] = useState<DayRow[]>(buildDayRows([]));
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    if (!doctorId) return;
    setLoading(true);
    const [d, h] = await Promise.all([
      apiFetch<AdminDoctorOut>(`/api/v1/admin/doctors/${doctorId}`),
      apiFetch<Hospital[]>("/api/v1/hospitals"),
    ]);
    setDoctor(d);
    setHospitals(h);
    setDays(buildDayRows(d.working_hours));
    setForm({});
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  if (loading || !doctor) {
    return (
      <PortalShell>
        <p className="text-sm text-slate-500">Loading...</p>
      </PortalShell>
    );
  }

  function field<K extends keyof DoctorUpdate>(key: K): DoctorUpdate[K] {
    return form[key] !== undefined ? form[key] : (doctor as unknown as DoctorUpdate)[key];
  }

  async function handleSaveProfile() {
    if (!doctorId || Object.keys(form).length === 0) return;
    setSavingProfile(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await apiFetch<AdminDoctorOut>(`/api/v1/admin/doctors/${doctorId}`, {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      setDoctor(updated);
      setForm({});
      setMessage("Profile updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this doctor.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleSaveHours() {
    if (!doctorId) return;
    setSavingHours(true);
    setError(null);
    setMessage(null);
    try {
      const body = days
        .map((d, weekday) => ({ ...d, weekday }))
        .filter((d) => d.enabled)
        .map((d) => ({ weekday: d.weekday, start_time: d.start_time, end_time: d.end_time }));
      await apiFetch(`/api/v1/admin/doctors/${doctorId}/working-hours`, { method: "PUT", body: JSON.stringify(body) });
      setMessage("Working hours updated.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update working hours.");
    } finally {
      setSavingHours(false);
    }
  }

  return (
    <PortalShell>
      <button onClick={() => navigate("/admin/doctors")} className="text-sm text-brand-600 hover:underline">
        &larr; All doctors
      </button>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">{doctor.full_name}</h1>
      <p className="text-sm text-slate-500">{doctor.email}</p>

      {message && <p className="mt-3 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="font-medium text-slate-900">Profile</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            value={field("full_name") as string}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            value={(field("specialisation") as string) ?? ""}
            onChange={(e) => setForm({ ...form, specialisation: e.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            value={(field("hospital_id") as string) ?? ""}
            onChange={(e) => setForm({ ...form, hospital_id: e.target.value || null })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">No hospital assigned</option>
            {hospitals.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            placeholder="Consultation fee"
            value={(field("consultation_fee") as number) ?? ""}
            onChange={(e) => setForm({ ...form, consultation_fee: e.target.value ? Number(e.target.value) : null })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={field("accepts_emergency") as boolean}
              onChange={(e) => setForm({ ...form, accepts_emergency: e.target.checked })}
            />
            Accepts emergencies
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={field("is_accepting") as boolean}
              onChange={(e) => setForm({ ...form, is_accepting: e.target.checked })}
            />
            Currently accepting bookings
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={field("is_active") as boolean}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            />
            Account active (unchecked disables login)
          </label>
        </div>
        <button
          onClick={handleSaveProfile}
          disabled={savingProfile || Object.keys(form).length === 0}
          className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {savingProfile ? "Saving..." : "Save profile"}
        </button>
      </div>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="font-medium text-slate-900">Working hours</h2>
        <div className="mt-3 space-y-2">
          {days.map((d, i) => (
            <div key={i} className="flex items-center gap-3">
              <label className="flex w-32 items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={d.enabled}
                  onChange={(e) => setDays((prev) => prev.map((row, j) => (j === i ? { ...row, enabled: e.target.checked } : row)))}
                />
                {WEEKDAY_NAMES[i]}
              </label>
              <input
                type="time"
                disabled={!d.enabled}
                value={d.start_time}
                onChange={(e) => setDays((prev) => prev.map((row, j) => (j === i ? { ...row, start_time: e.target.value } : row)))}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
              />
              <span className="text-sm text-slate-400">to</span>
              <input
                type="time"
                disabled={!d.enabled}
                value={d.end_time}
                onChange={(e) => setDays((prev) => prev.map((row, j) => (j === i ? { ...row, end_time: e.target.value } : row)))}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
              />
            </div>
          ))}
        </div>
        <button
          onClick={handleSaveHours}
          disabled={savingHours}
          className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {savingHours ? "Saving..." : "Save working hours"}
        </button>
      </div>

      <AdminLeavePanel doctorId={doctor.user_id} />
    </PortalShell>
  );
}

function AdminLeavePanel({ doctorId }: { doctorId: string }) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [preview, setPreview] = useState<LeaveImpactPreview | null>(null);
  const [confirmed, setConfirmed] = useState<LeaveOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePreview() {
    setBusy(true);
    setError(null);
    setConfirmed(null);
    try {
      const result = await apiFetch<LeaveImpactPreview>(`/api/v1/admin/doctors/${doctorId}/leave`, {
        method: "POST",
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      setPreview(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not preview leave.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<LeaveOut>(`/api/v1/admin/doctors/${doctorId}/leave/confirm`, {
        method: "POST",
        body: JSON.stringify({ start_date: preview.start_date, end_date: preview.end_date }),
      });
      setConfirmed(result);
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not confirm leave.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="font-medium text-slate-900">Set leave</h2>
      {confirmed && (
        <p className="mt-2 text-sm text-green-700">
          Leave confirmed {confirmed.start_date} to {confirmed.end_date}.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-slate-500">Start</label>
          <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setPreview(null); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500">End</label>
          <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setPreview(null); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
        </div>
        {!preview && (
          <button onClick={handlePreview} disabled={busy || !startDate || !endDate} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            Preview impact
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}

      {preview && (
        <div className="mt-4">
          {preview.affected_count === 0 ? (
            <p className="text-sm text-slate-600">No appointments affected.</p>
          ) : (
            <ul className="space-y-2">
              {preview.affected.map((a) => (
                <li key={a.appointment_id} className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                  {a.patient_name} -- {new Date(a.start_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-3">
            <button onClick={handleConfirm} disabled={busy} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
              Confirm leave
            </button>
            <button onClick={() => setPreview(null)} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
