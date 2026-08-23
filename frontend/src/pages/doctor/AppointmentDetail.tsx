import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  Appointment,
  EncounterCreate,
  EncounterOut,
  PostVisitSummaryContent,
  PreVisitSummaryContent,
  PrescriptionIn,
  SummaryOut,
} from "@/lib/types";

const FREQUENCY_CODES = ["OD", "BD", "TDS", "QID", "HS", "SOS", "Q6H"];
const URGENCY_COLOR: Record<string, string> = {
  low: "bg-slate-100 text-slate-600",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-emergency-700",
};

function emptyPrescription(): PrescriptionIn {
  return {
    drug_name: "",
    strength: "",
    form: "",
    frequency_code: "OD",
    relation_to_food: "",
    duration_days: 5,
    start_date: new Date().toISOString().slice(0, 10),
    instructions: "",
  };
}

export default function AppointmentDetail() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [preVisit, setPreVisit] = useState<SummaryOut | null>(null);
  const [encounter, setEncounter] = useState<EncounterOut | null>(null);
  const [postVisit, setPostVisit] = useState<SummaryOut | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    if (!appointmentId) return;
    setLoading(true);
    const [apptResult, preResult, encResult] = await Promise.allSettled([
      apiFetch<Appointment>(`/api/v1/appointments/${appointmentId}`),
      apiFetch<SummaryOut>(`/api/v1/appointments/${appointmentId}/pre-visit-summary`),
      apiFetch<EncounterOut>(`/api/v1/appointments/${appointmentId}/encounter`),
    ]);
    if (apptResult.status === "fulfilled") setAppointment(apptResult.value);
    setPreVisit(preResult.status === "fulfilled" ? preResult.value : null);
    setEncounter(encResult.status === "fulfilled" ? encResult.value : null);

    if (encResult.status === "fulfilled") {
      const postResult = await apiFetch<SummaryOut>(`/api/v1/appointments/${appointmentId}/post-visit-summary`).catch(
        () => null
      );
      setPostVisit(postResult);
    } else {
      setPostVisit(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  if (loading) {
    return (
      <PortalShell>
        <p className="text-sm text-slate-500">Loading...</p>
      </PortalShell>
    );
  }

  if (!appointment) {
    return (
      <PortalShell>
        <p className="text-sm text-emergency-600">Appointment not found.</p>
      </PortalShell>
    );
  }

  // state='failed' (e.g. no LLM provider reachable) still creates a row, but with
  // content={} -- only 'draft' carries a real, fully-shaped PreVisitSummary.
  const preContent =
    preVisit?.state === "draft" ? (preVisit.content as unknown as PreVisitSummaryContent) : undefined;

  return (
    <PortalShell>
      <h1 className="text-2xl font-semibold text-slate-900">{appointment.patient_name}</h1>
      <p className="text-sm text-slate-500">
        {new Date(appointment.start_at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
      </p>

      <div className="mt-6 space-y-6">
        <PreVisitPanel content={preContent} state={preVisit?.state} />

        {!encounter ? (
          <EncounterForm appointmentId={appointment.id} onSubmitted={loadAll} />
        ) : (
          <EncounterView encounter={encounter} />
        )}

        {encounter && <PostVisitPanel encounterId={encounter.id} summary={postVisit} onChange={loadAll} />}
      </div>
    </PortalShell>
  );
}

function PreVisitPanel({ content, state }: { content: PreVisitSummaryContent | undefined; state: string | undefined }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="font-medium text-slate-900">Pre-visit summary</h2>
      {!content && state !== "failed" && (
        <p className="mt-2 text-sm text-slate-500">
          Not generated yet -- runs automatically within 10 minutes of booking.
        </p>
      )}
      {!content && state === "failed" && (
        <p className="mt-2 text-sm text-slate-500">
          Could not be generated (no LLM provider reachable). Proceed on the visit itself.
        </p>
      )}
      {content && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${URGENCY_COLOR[content.urgency] ?? ""}`}>
              {content.urgency}
            </span>
            <p className="font-medium text-slate-800">{content.chief_complaint}</p>
          </div>
          <p className="text-sm text-slate-700">{content.hpi}</p>

          {content.questions_for_doctor.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase text-slate-500">Suggested questions</p>
              <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                {content.questions_for_doctor.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          {content.information_gaps.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase text-slate-500">Information gaps</p>
              <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                {content.information_gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            {content.current_medications.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">Current medications</p>
                <p className="text-slate-700">{content.current_medications.join(", ")}</p>
              </div>
            )}
            {content.allergies.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">Allergies</p>
                <p className="text-slate-700">{content.allergies.join(", ")}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function EncounterForm({ appointmentId, onSubmitted }: { appointmentId: string; onSubmitted: () => void }) {
  const [clinicalNotes, setClinicalNotes] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [followUpDays, setFollowUpDays] = useState<string>("");
  const [bp, setBp] = useState("");
  const [pulse, setPulse] = useState("");
  const [temp, setTemp] = useState("");
  const [spo2, setSpo2] = useState("");
  const [prescriptions, setPrescriptions] = useState<PrescriptionIn[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updatePrescription(idx: number, patch: Partial<PrescriptionIn>) {
    setPrescriptions((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const vitals: Record<string, string> = {};
    if (bp) vitals.blood_pressure = bp;
    if (pulse) vitals.pulse = pulse;
    if (temp) vitals.temperature = temp;
    if (spo2) vitals.spo2 = spo2;

    const body: EncounterCreate = {
      appointment_id: appointmentId,
      clinical_notes: clinicalNotes || null,
      diagnosis: diagnosis || null,
      vitals: Object.keys(vitals).length > 0 ? vitals : null,
      follow_up_after_days: followUpDays ? Number(followUpDays) : null,
      prescriptions,
    };
    try {
      await apiFetch("/api/v1/encounters", { method: "POST", body: JSON.stringify(body) });
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit visit notes.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="font-medium text-slate-900">Visit notes</h2>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <input placeholder="BP" value={bp} onChange={(e) => setBp(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
        <input placeholder="Pulse" value={pulse} onChange={(e) => setPulse(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
        <input placeholder="Temp" value={temp} onChange={(e) => setTemp(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
        <input placeholder="SpO2" value={spo2} onChange={(e) => setSpo2(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </div>

      <textarea
        placeholder="Clinical notes"
        value={clinicalNotes}
        onChange={(e) => setClinicalNotes(e.target.value)}
        rows={4}
        className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        placeholder="Diagnosis"
        value={diagnosis}
        onChange={(e) => setDiagnosis(e.target.value)}
        className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        type="number"
        placeholder="Follow-up in (days)"
        value={followUpDays}
        onChange={(e) => setFollowUpDays(e.target.value)}
        className="mt-3 w-48 rounded-md border border-slate-300 px-3 py-2 text-sm"
      />

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">Prescriptions</p>
          <button
            onClick={() => setPrescriptions((prev) => [...prev, emptyPrescription()])}
            className="text-sm text-brand-600 hover:underline"
          >
            + Add medicine
          </button>
        </div>
        <div className="mt-2 space-y-2">
          {prescriptions.map((p, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-6">
              <input
                placeholder="Drug name"
                value={p.drug_name}
                onChange={(e) => updatePrescription(idx, { drug_name: e.target.value })}
                className="col-span-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <input
                placeholder="Strength"
                value={p.strength ?? ""}
                onChange={(e) => updatePrescription(idx, { strength: e.target.value })}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <select
                value={p.frequency_code}
                onChange={(e) => updatePrescription(idx, { frequency_code: e.target.value })}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {FREQUENCY_CODES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Days"
                value={p.duration_days}
                onChange={(e) => updatePrescription(idx, { duration_days: Number(e.target.value) })}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <button
                onClick={() => setPrescriptions((prev) => prev.filter((_, i) => i !== idx))}
                className="text-sm text-emergency-600 hover:underline"
              >
                Remove
              </button>
              <input
                placeholder="Instructions"
                value={p.instructions ?? ""}
                onChange={(e) => updatePrescription(idx, { instructions: e.target.value })}
                className="col-span-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm sm:col-span-6"
              />
            </div>
          ))}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {submitting ? "Submitting..." : "Submit visit notes"}
      </button>
    </section>
  );
}

function EncounterView({ encounter }: { encounter: EncounterOut }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="font-medium text-slate-900">Visit notes</h2>
      {encounter.diagnosis && <p className="mt-2 text-sm text-slate-700">Diagnosis: {encounter.diagnosis}</p>}
      {encounter.clinical_notes && <p className="mt-2 text-sm text-slate-700">{encounter.clinical_notes}</p>}
      {encounter.vitals && Object.keys(encounter.vitals).length > 0 && (
        <p className="mt-2 text-sm text-slate-500">
          {Object.entries(encounter.vitals)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" -- ")}
        </p>
      )}
      {encounter.prescriptions.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Prescriptions</p>
          <ul className="mt-1 text-sm text-slate-700">
            {encounter.prescriptions.map((p) => (
              <li key={p.id}>
                {p.drug_name} {p.strength} -- {p.frequency_code} for {p.duration_days} days
                {p.instructions ? ` (${p.instructions})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PostVisitPanel({
  encounterId,
  summary,
  onChange,
}: {
  encounterId: string;
  summary: SummaryOut | null;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [discussedDraft, setDiscussedDraft] = useState("");
  const [foundDraft, setFoundDraft] = useState("");

  const content = (summary?.content_edited ?? summary?.content) as PostVisitSummaryContent | undefined;
  const finalized = summary?.state === "approved" || summary?.state === "edited";

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/encounters/${encounterId}/generate-summary`, { method: "POST" });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not generate the summary.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove(withEdits: boolean) {
    if (!summary) return;
    setBusy(true);
    setError(null);
    try {
      const edited_content = withEdits && content ? { ...content, what_we_discussed: discussedDraft, what_the_doctor_found: foundDraft } : null;
      await apiFetch(`/api/v1/summaries/${summary.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ edited_content }),
      });
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not approve the summary.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!summary) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/summaries/${summary.id}/reject`, { method: "POST" });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject the summary.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-slate-900">Post-visit summary (patient-facing)</h2>
        {summary && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {summary.state}
          </span>
        )}
      </div>

      {!summary && (
        <>
          <p className="mt-2 text-sm text-slate-500">Not generated yet.</p>
          <button
            onClick={handleGenerate}
            disabled={busy}
            className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? "Generating..." : "Generate summary"}
          </button>
        </>
      )}

      {summary && summary.state === "failed" && (
        <>
          <p className="mt-2 text-sm text-slate-500">Generation failed: {summary.generation_error}</p>
          <button
            onClick={handleGenerate}
            disabled={busy}
            className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            Retry
          </button>
        </>
      )}

      {summary && summary.state === "rejected" && (
        <>
          <p className="mt-2 text-sm text-slate-500">Rejected. Generate a new one?</p>
          <button
            onClick={handleGenerate}
            disabled={busy}
            className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            Regenerate
          </button>
        </>
      )}

      {content && (summary?.state === "draft" || finalized) && (
        <div className="mt-3 space-y-3">
          {!editing ? (
            <p className="text-sm text-slate-700">{content.what_we_discussed}</p>
          ) : (
            <textarea
              value={discussedDraft || content.what_we_discussed}
              onChange={(e) => setDiscussedDraft(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          )}
          {content.medication_schedule.length > 0 && (
            <ul className="text-sm text-slate-600">
              {content.medication_schedule.map((m, i) => (
                <li key={i}>
                  {m.drug} -- {m.dose} -- {m.when}
                </li>
              ))}
            </ul>
          )}

          {!finalized && !editing && (
            <div className="flex gap-3">
              <button
                onClick={() => handleApprove(false)}
                disabled={busy}
                className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
              >
                Approve as-is
              </button>
              <button
                onClick={() => {
                  setDiscussedDraft(content.what_we_discussed);
                  setFoundDraft(content.what_the_doctor_found);
                  setEditing(true);
                }}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                Edit
              </button>
              <button
                onClick={handleReject}
                disabled={busy}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-emergency-600 hover:bg-red-50"
              >
                Reject
              </button>
            </div>
          )}

          {!finalized && editing && (
            <div className="flex gap-3">
              <button
                onClick={() => handleApprove(true)}
                disabled={busy}
                className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
              >
                Save edits &amp; approve
              </button>
              <button onClick={() => setEditing(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">
                Cancel
              </button>
            </div>
          )}

          {finalized && <p className="text-xs text-green-700">Approved -- visible to the patient.</p>}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}
    </section>
  );
}
