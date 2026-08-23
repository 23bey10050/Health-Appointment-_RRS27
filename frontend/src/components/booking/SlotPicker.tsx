import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import type { Appointment, AvailabilityOut, DoctorListItem } from "@/lib/types";

const WINDOW_DAYS = 7;
const HOLD_SECONDS = 300; // SLOT_HOLD_TTL_SECONDS -- see backend/.env

function groupByDay(slots: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const slot of slots) {
    const day = new Date(slot).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const list = groups.get(day) ?? [];
    list.push(slot);
    groups.set(day, list);
  }
  return groups;
}

export function SlotPicker({
  doctor,
  onBack,
  onBooked,
}: {
  doctor: DoctorListItem;
  onBack: () => void;
  onBooked: (appointment: Appointment) => void;
}) {
  const [availability, setAvailability] = useState<AvailabilityOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [held, setHeld] = useState<Appointment | null>(null);
  const [remainingSec, setRemainingSec] = useState(HOLD_SECONDS);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Symptom intake, collected while the slot is held. The doctor's pre-visit
  // summary is generated from this, so it is gathered before confirming rather
  // than afterwards.
  const [symptoms, setSymptoms] = useState("");
  const [duration, setDuration] = useState("");
  const [severity, setSeverity] = useState("");
  const [existingConditions, setExistingConditions] = useState("");
  const [currentMedications, setCurrentMedications] = useState("");
  const [allergies, setAllergies] = useState("");

  useEffect(() => {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + WINDOW_DAYS);
    const params = new URLSearchParams({
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10),
    });
    apiFetch<AvailabilityOut>(`/api/v1/doctors/${doctor.user_id}/availability?${params.toString()}`)
      .then(setAvailability)
      .catch(() => setError("Could not load availability."))
      .finally(() => setLoading(false));
  }, [doctor.user_id]);

  useEffect(() => {
    if (!held) return;
    const expiresAt = held.hold_expires_at ? new Date(held.hold_expires_at).getTime() : Date.now() + HOLD_SECONDS * 1000;
    const interval = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setRemainingSec(left);
      if (left === 0) {
        clearInterval(interval);
        setHeld(null);
        setError("Your hold expired. Please pick a slot again.");
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [held]);

  async function handlePickSlot(slot: string) {
    setError(null);
    try {
      const appointment = await apiFetch<Appointment>("/api/v1/appointments/hold", {
        method: "POST",
        body: JSON.stringify({ doctor_id: doctor.user_id, start_at: slot }),
      });
      setHeld(appointment);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That slot is no longer available.");
    }
  }

  async function handleConfirm() {
    if (!held) return;
    if (symptoms.trim().length < 3) {
      setError("Please describe your symptoms so the doctor can prepare.");
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const confirmed = await apiFetch<Appointment>(`/api/v1/appointments/${held.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          symptom_intake: {
            symptoms: symptoms.trim(),
            duration: duration.trim() || null,
            severity: severity ? Number(severity) : null,
            existing_conditions: existingConditions.trim() || null,
            current_medications: currentMedications.trim() || null,
            allergies: allergies.trim() || null,
          },
        }),
      });
      onBooked(confirmed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not confirm the booking.");
    } finally {
      setConfirming(false);
    }
  }

  async function handleCancelHold() {
    if (!held) return;
    try {
      await apiFetch(`/api/v1/appointments/${held.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "patient_changed_mind" }),
      });
    } catch {
      // best-effort -- the hold expires on its own regardless
    }
    setHeld(null);
  }

  if (held) {
    const minutes = String(Math.floor(remainingSec / 60)).padStart(2, "0");
    const seconds = String(remainingSec % 60).padStart(2, "0");
    return (
      <div className="rounded-lg border border-brand-200 bg-brand-50 p-6">
        <h2 className="text-lg font-semibold text-slate-900">Confirm your booking</h2>
        <p className="mt-2 text-sm text-slate-700">
          {doctor.full_name} -- {new Date(held.start_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          Slot held for <span className="font-mono font-medium text-brand-700">{minutes}:{seconds}</span>
        </p>

        <div className="mt-5 border-t border-brand-200 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Tell the doctor why you are coming in</h3>
          <p className="mt-1 text-xs text-slate-500">
            This is summarised for your doctor before the visit, so they can prepare. It is not a diagnosis
            and it is not seen by anyone else.
          </p>

          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700" htmlFor="symptoms">
                What is bothering you? <span className="text-emergency-600">*</span>
              </label>
              <textarea
                id="symptoms"
                required
                rows={3}
                value={symptoms}
                onChange={(e) => setSymptoms(e.target.value)}
                placeholder="Describe your symptoms in your own words"
                className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="duration">
                  How long have you had this?
                </label>
                <input
                  id="duration"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  placeholder="e.g. 3 days"
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="severity">
                  How bad is it, 1 to 10?
                </label>
                <select
                  id="severity"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                >
                  <option value="">Prefer not to say</option>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700" htmlFor="conditions">
                Any ongoing conditions?
              </label>
              <input
                id="conditions"
                value={existingConditions}
                onChange={(e) => setExistingConditions(e.target.value)}
                placeholder="e.g. diabetes, asthma"
                className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="medications">
                  Medicines you take now
                </label>
                <input
                  id="medications"
                  value={currentMedications}
                  onChange={(e) => setCurrentMedications(e.target.value)}
                  placeholder="Include doses if you know them"
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="allergies">
                  Allergies
                </label>
                <input
                  id="allergies"
                  value={allergies}
                  onChange={(e) => setAllergies(e.target.value)}
                  placeholder="Medicines, food, anything else"
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
            </div>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}
        <div className="mt-5 flex gap-3">
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {confirming ? "Confirming..." : "Confirm booking"}
          </button>
          <button
            onClick={handleCancelHold}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            Choose a different slot
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} className="text-sm text-brand-600 hover:underline">
        &larr; Back to search
      </button>
      <h2 className="mt-2 text-lg font-semibold text-slate-900">{doctor.full_name}</h2>
      <p className="text-sm text-slate-500">
        {doctor.specialisation} {doctor.hospital_name ? `-- ${doctor.hospital_name}` : ""}
      </p>

      {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}
      {loading && <p className="mt-4 text-sm text-slate-500">Loading availability...</p>}

      {availability && availability.slots.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No open slots in the next {WINDOW_DAYS} days.</p>
      )}

      {availability && availability.slots.length > 0 && (
        <div className="mt-4 space-y-4">
          {Array.from(groupByDay(availability.slots)).map(([day, slots]) => (
            <div key={day}>
              <p className="text-sm font-medium text-slate-700">{day}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {slots.map((slot) => (
                  <button
                    key={slot}
                    onClick={() => handlePickSlot(slot)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:border-brand-500 hover:bg-brand-50"
                  >
                    {new Date(slot).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
