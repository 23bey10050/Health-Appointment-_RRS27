import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type { AdminDoctorOut, DoctorCreate, Hospital } from "@/lib/types";

const SPECIALISATIONS = [
  "General Medicine",
  "Cardiology",
  "Pediatrics",
  "Dermatology",
  "Orthopedics",
  "ENT",
];

function emptyDoctor(): DoctorCreate {
  return {
    email: "",
    full_name: "",
    password: "",
    specialisation: SPECIALISATIONS[0],
    sub_specialisations: [],
    slot_duration_min: 20,
    buffer_min: 0,
    accepts_emergency: false,
    is_accepting: true,
    working_hours: [],
  };
}

export default function AdminDoctors() {
  const [doctors, setDoctors] = useState<AdminDoctorOut[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<DoctorCreate>(emptyDoctor());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [docs, hosps] = await Promise.all([
      apiFetch<AdminDoctorOut[]>("/api/v1/admin/doctors"),
      apiFetch<Hospital[]>("/api/v1/hospitals"),
    ]);
    setDoctors(docs);
    setHospitals(hosps);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/v1/admin/doctors", { method: "POST", body: JSON.stringify(form) });
      setShowForm(false);
      setForm(emptyDoctor());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this doctor.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PortalShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Doctors</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {showForm ? "Cancel" : "+ Add doctor"}
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              placeholder="Full name"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              placeholder="Email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              placeholder="Temporary password"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              placeholder="Phone (optional)"
              value={form.phone ?? ""}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={form.specialisation}
              onChange={(e) => setForm({ ...form, specialisation: e.target.value })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {SPECIALISATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={form.hospital_id ?? ""}
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
              value={form.consultation_fee ?? ""}
              onChange={(e) => setForm({ ...form, consultation_fee: e.target.value ? Number(e.target.value) : null })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              placeholder="Years of experience"
              value={form.years_experience ?? ""}
              onChange={(e) => setForm({ ...form, years_experience: e.target.value ? Number(e.target.value) : null })}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.accepts_emergency}
                onChange={(e) => setForm({ ...form, accepts_emergency: e.target.checked })}
              />
              Accepts emergencies (on-call eligible)
            </label>
          </div>

          {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}

          <button
            onClick={handleCreate}
            disabled={submitting || !form.full_name || !form.email || !form.password}
            className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {submitting ? "Creating..." : "Create doctor"}
          </button>
          <p className="mt-2 text-xs text-slate-400">Working hours can be set after creation, from the doctor's detail page.</p>
        </div>
      )}

      {loading && <p className="mt-4 text-sm text-slate-500">Loading...</p>}

      <div className="mt-6 space-y-2">
        {doctors.map((d) => (
          <Link
            key={d.user_id}
            to={`/admin/doctors/${d.user_id}`}
            className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-brand-400 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-900">{d.full_name}</p>
                <p className="text-sm text-slate-500">
                  {d.specialisation} {d.hospital_name ? `-- ${d.hospital_name}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {d.accepts_emergency && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-emergency-700">
                    On-call
                  </span>
                )}
                {!d.is_accepting && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                    Not accepting
                  </span>
                )}
                {!d.is_active && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                    Disabled
                  </span>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </PortalShell>
  );
}
