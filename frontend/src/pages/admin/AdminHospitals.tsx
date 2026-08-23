import { useEffect, useState } from "react";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type { Hospital, HospitalCreate } from "@/lib/types";

function emptyHospital(): HospitalCreate {
  return { name: "", address: "", city: "", phone: "", has_emergency_dept: false };
}

export default function AdminHospitals() {
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<HospitalCreate>(emptyHospital());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setHospitals(await apiFetch<Hospital[]>("/api/v1/hospitals"));
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(h: Hospital) {
    setEditingId(h.id);
    setForm({ name: h.name, address: h.address ?? "", city: h.city ?? "", phone: h.phone ?? "", has_emergency_dept: h.has_emergency_dept });
    setShowForm(true);
  }

  function startCreate() {
    setEditingId(null);
    setForm(emptyHospital());
    setShowForm(true);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      if (editingId) {
        await apiFetch(`/api/v1/admin/hospitals/${editingId}`, { method: "PATCH", body: JSON.stringify(form) });
      } else {
        await apiFetch("/api/v1/admin/hospitals", { method: "POST", body: JSON.stringify(form) });
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this hospital.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PortalShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Hospitals</h1>
        <button onClick={startCreate} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          + Add hospital
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <input placeholder="City" value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <input placeholder="Address" value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.target.value })} className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <input placeholder="Phone" value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.has_emergency_dept} onChange={(e) => setForm({ ...form, has_emergency_dept: e.target.checked })} />
              Has emergency department
            </label>
          </div>
          {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}
          <div className="mt-4 flex gap-3">
            <button onClick={handleSubmit} disabled={submitting || !form.name} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
              {submitting ? "Saving..." : editingId ? "Save changes" : "Create hospital"}
            </button>
            <button onClick={() => setShowForm(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && <p className="mt-4 text-sm text-slate-500">Loading...</p>}

      <div className="mt-6 space-y-2">
        {hospitals.map((h) => (
          <button key={h.id} onClick={() => startEdit(h)} className="block w-full rounded-lg border border-slate-200 bg-white p-4 text-left hover:border-brand-400 hover:shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-900">{h.name}</p>
                <p className="text-sm text-slate-500">{[h.address, h.city].filter(Boolean).join(", ")}</p>
              </div>
              {h.has_emergency_dept && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-emergency-700">Emergency dept</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </PortalShell>
  );
}
