import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { EMERGENCY_CATEGORY_LABEL } from "@/lib/emergencyCategories";
import type { EmergencyQueueEntry } from "@/lib/types";

const POLL_INTERVAL_MS = 15000;

export function EmergencyQueuePanel() {
  const [entries, setEntries] = useState<EmergencyQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<EmergencyQueueEntry[]>("/api/v1/emergency-queue");
      setEntries(data);
    } catch {
      // Best-effort in-portal notification; the email alert already went out
      // independently (safety/escalation.py), so a fetch failure here doesn't
      // hide the emergency, just the doctor's live queue view.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAcknowledge(id: string) {
    setBusyId(id);
    try {
      const updated = await apiFetch<EmergencyQueueEntry>(`/api/v1/emergency-queue/${id}/acknowledge`, {
        method: "POST",
      });
      setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)));
    } finally {
      setBusyId(null);
    }
  }

  async function handleResolve(id: string) {
    setBusyId(id);
    try {
      const updated = await apiFetch<EmergencyQueueEntry>(`/api/v1/emergency-queue/${id}/resolve`, {
        method: "POST",
      });
      setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return null;

  const open = entries.filter((e) => e.status !== "resolved");
  const resolved = entries.filter((e) => e.status === "resolved").slice(0, 5);

  if (open.length === 0 && resolved.length === 0) return null;

  return (
    <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2">
      {open.map((entry) => (
        <EmergencyCard key={entry.id} entry={entry} busy={busyId === entry.id} onAcknowledge={handleAcknowledge} onResolve={handleResolve} />
      ))}
      {resolved.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-white/60 backdrop-blur-sm p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 outline-none">
            Recently resolved ({resolved.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-slate-500">
            {resolved.map((e) => (
              <li key={e.id}>
                {EMERGENCY_CATEGORY_LABEL[e.category] ?? e.category} -- {e.patient_name ?? "Unknown patient"} --
                resolved {new Date(e.resolved_at!).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function EmergencyCard({
  entry,
  busy,
  onAcknowledge,
  onResolve,
}: {
  entry: EmergencyQueueEntry;
  busy: boolean;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
}) {
  const isActive = entry.status === "active";
  const label = EMERGENCY_CATEGORY_LABEL[entry.category] ?? "Medical emergency";

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm backdrop-blur-sm transition-all flex flex-col gap-3 ${isActive ? "border-red-400 bg-red-50/80" : "border-amber-300 bg-amber-50/80"}`}
      role="alert"
    >
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shadow-sm ${isActive ? "bg-red-600 text-white" : "bg-amber-500 text-white"}`}>
            {isActive ? "ACTIVE" : "ACKNOWLEDGED"}
          </span>
          <span className="text-xs text-slate-500 font-medium bg-white/50 px-2 py-0.5 rounded-full">
            {new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        
        <h3 className="text-base font-bold text-slate-900 leading-tight">{label}</h3>
        
        <p className="text-sm text-slate-700 font-semibold mt-1">
          {entry.patient_name ?? "Unknown patient"}
        </p>
        
        {entry.summary && (
          <p className="mt-2 text-xs text-slate-700 bg-white/60 p-2.5 rounded-lg border border-white/40 shadow-inner break-words leading-relaxed">
            {entry.summary}
          </p>
        )}

        {entry.ambulance_required === true && (
          <p className="mt-2 inline-block rounded-md bg-emergency-700 px-2 py-1 text-xs font-bold text-white shadow-sm">
            AMBULANCE REQUESTED
          </p>
        )}
        {entry.ambulance_required === false && (
          <p className="mt-2 text-xs text-slate-500 italic">No ambulance requested.</p>
        )}

        {(entry.callback_name || entry.callback_phone) && (
          <div className="mt-2 text-xs text-slate-700 bg-white/40 p-2 rounded-lg border border-white/50">
            <span className="text-slate-500">Callback:</span> <span className="font-semibold">{entry.callback_name ?? "name not given"}</span>
            {entry.callback_phone && (
              <div className="mt-0.5">
                <a href={`tel:${entry.callback_phone}`} className="font-semibold text-brand-700 hover:underline">
                  {entry.callback_phone}
                </a>
              </div>
            )}
          </div>
        )}

        {entry.appointment_id && (
          <p className="mt-2 text-[10px] uppercase font-bold text-slate-400">
            Ref {entry.appointment_id.slice(0, 8)}
          </p>
        )}
      </div>

      <div className="flex gap-2 mt-1">
        {isActive && (
          <button
            onClick={() => onAcknowledge(entry.id)}
            disabled={busy}
            className="flex-1 rounded-lg bg-red-600 px-2 py-2 text-xs font-bold text-white hover:bg-red-700 transition-colors disabled:opacity-60 shadow-sm"
          >
            Acknowledge
          </button>
        )}
        <button
          onClick={() => onResolve(entry.id)}
          disabled={busy}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-60 shadow-sm"
        >
          Mark resolved
        </button>
      </div>

      {entry.brief && (
        <details className="mt-4 rounded-lg border border-slate-300 bg-white/70 p-4 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700 outline-none hover:text-slate-900 transition-colors">
            View AI Decision Support
          </summary>
          <div className="mt-3 pt-3 border-t border-slate-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              AI decision support -- not a diagnosis. Verify independently.
            </p>
            <p className="mt-2 text-sm text-slate-800">{entry.brief.presentation_summary}</p>

            {entry.brief.vital_concerns.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-slate-500">Vital concerns</p>
                <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                  {entry.brief.vital_concerns.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              </div>
            )}

            {entry.brief.differential_considerations.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-slate-500">Considerations (not diagnoses)</p>
                <ul className="mt-1 space-y-2">
                  {entry.brief.differential_considerations.map((d, i) => (
                    <li key={i} className="text-sm text-slate-700">
                      <span className="font-medium">{d.consideration}</span>{" "}
                      <span className="text-slate-500">({d.time_criticality})</span>
                      {d.cannot_exclude_because.length > 0 && (
                        <span className="block text-xs text-slate-500">
                          Cannot exclude: {d.cannot_exclude_because.join("; ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {entry.brief.immediate_actions_to_consider.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-slate-500">Immediate actions to consider</p>
                <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                  {entry.brief.immediate_actions_to_consider.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-3 text-xs italic text-slate-500">{entry.brief.limitations}</p>
          </div>
        </details>
      )}
      {!entry.brief && (
        <p className="mt-3 text-xs text-slate-500">
          AI decision-support brief unavailable (this can happen when no LLM provider is
          reachable); proceed on clinical judgement.
        </p>
      )}
    </div>
  );
}
