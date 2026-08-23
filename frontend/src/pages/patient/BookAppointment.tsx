import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SlotPicker } from "@/components/booking/SlotPicker";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch } from "@/lib/api";
import type { Appointment, DoctorListItem, Hospital } from "@/lib/types";

export default function BookAppointment() {
  const navigate = useNavigate();
  const [specialisations, setSpecialisations] = useState<string[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [specialisation, setSpecialisation] = useState("");
  const [hospitalId, setHospitalId] = useState("");
  const [q, setQ] = useState("");
  const [doctors, setDoctors] = useState<DoctorListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDoctor, setSelectedDoctor] = useState<DoctorListItem | null>(null);
  const [booked, setBooked] = useState<Appointment | null>(null);

  useEffect(() => {
    apiFetch<string[]>("/api/v1/specialisations").then(setSpecialisations).catch(() => {});
    apiFetch<Hospital[]>("/api/v1/hospitals").then(setHospitals).catch(() => {});
  }, []);

  async function search() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (specialisation) params.set("specialisation", specialisation);
      if (hospitalId) params.set("hospital_id", hospitalId);
      if (q) params.set("q", q);
      const results = await apiFetch<DoctorListItem[]>(`/api/v1/doctors?${params.toString()}`);
      setDoctors(results);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (booked) {
    return (
      <PortalShell>
        <div className="rounded-lg border border-green-200 bg-green-50 p-6">
          <h1 className="text-lg font-semibold text-slate-900">Appointment confirmed</h1>
          <p className="mt-2 text-sm text-slate-700">
            {new Date(booked.start_at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
          </p>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => navigate("/patient/appointments")}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              View my appointments
            </button>
            <button
              onClick={() => {
                setBooked(null);
                setSelectedDoctor(null);
              }}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              Book another
            </button>
          </div>
        </div>
      </PortalShell>
    );
  }

  if (selectedDoctor) {
    return (
      <PortalShell>
        <SlotPicker doctor={selectedDoctor} onBack={() => setSelectedDoctor(null)} onBooked={setBooked} />
      </PortalShell>
    );
  }

  return (
    <PortalShell>
      <h1 className="text-2xl font-semibold text-slate-900">Find a doctor</h1>

      <div className="mt-4 flex flex-wrap gap-3">
        <select
          value={specialisation}
          onChange={(e) => setSpecialisation(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">All specialisations</option>
          {specialisations.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={hospitalId}
          onChange={(e) => setHospitalId(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">All hospitals</option>
          {hospitals.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search by name..."
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          onClick={search}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Search
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {loading && <p className="text-sm text-slate-500">Loading doctors...</p>}
        {!loading && doctors.length === 0 && <p className="text-sm text-slate-500">No doctors match your search.</p>}
        {doctors.map((doctor) => (
          <button
            key={doctor.user_id}
            onClick={() => setSelectedDoctor(doctor)}
            className="block w-full rounded-lg border border-slate-200 bg-white p-4 text-left hover:border-brand-400 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-900">{doctor.full_name}</p>
                <p className="text-sm text-slate-500">
                  {doctor.specialisation} {doctor.hospital_name ? `-- ${doctor.hospital_name}` : ""}
                </p>
                {doctor.years_experience !== null && (
                  <p className="text-xs text-slate-400">{doctor.years_experience} years experience</p>
                )}
              </div>
              <div className="text-right">
                {doctor.consultation_fee !== null && (
                  <p className="text-sm font-medium text-slate-700">Rs {doctor.consultation_fee}</p>
                )}
                <p className="text-xs text-slate-500">
                  {doctor.next_available
                    ? `Next: ${new Date(doctor.next_available).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                    : "No slots soon"}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </PortalShell>
  );
}
