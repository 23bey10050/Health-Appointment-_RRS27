import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type { PostVisitSummaryContent, SummaryOut } from "@/lib/types";

export default function VisitSummary() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const [summary, setSummary] = useState<SummaryOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!appointmentId) return;
    apiFetch<SummaryOut>(`/api/v1/appointments/${appointmentId}/post-visit-summary`)
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your visit summary."))
      .finally(() => setLoading(false));
  }, [appointmentId]);

  const content = (summary?.content_edited ?? summary?.content) as PostVisitSummaryContent | undefined;

  return (
    <PortalShell>
      <h1 className="text-2xl font-semibold text-slate-900">Visit summary</h1>

      {loading && <p className="mt-4 text-sm text-slate-500">Loading...</p>}
      {error && <p className="mt-4 text-sm text-slate-500">{error} It may not have been generated yet.</p>}

      {content && (
        <div className="mt-6 space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="font-medium text-slate-900">What we discussed</h2>
            <p className="mt-2 text-sm text-slate-700">{content.what_we_discussed}</p>
            {content.what_the_doctor_found && (
              <p className="mt-2 text-sm text-slate-700">{content.what_the_doctor_found}</p>
            )}
          </section>

          {content.medication_schedule.length > 0 && (
            <section className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="font-medium text-slate-900">Your medications</h2>
              <div className="mt-3 space-y-3">
                {content.medication_schedule.map((m, i) => (
                  <div key={i} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                    <p className="font-medium text-slate-800">
                      {m.drug} -- {m.dose}
                    </p>
                    <p className="text-sm text-slate-600">
                      {m.when}
                      {m.with_food ? ` -- ${m.with_food}` : ""}
                      {m.for_how_long ? ` -- for ${m.for_how_long}` : ""}
                    </p>
                    {m.why && <p className="text-xs text-slate-500">{m.why}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {(content.things_to_do.length > 0 || content.things_to_avoid.length > 0) && (
            <section className="grid gap-4 sm:grid-cols-2">
              {content.things_to_do.length > 0 && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-5">
                  <h2 className="font-medium text-green-900">Things to do</h2>
                  <ul className="mt-2 list-inside list-disc text-sm text-green-800">
                    {content.things_to_do.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
              {content.things_to_avoid.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-5">
                  <h2 className="font-medium text-amber-900">Things to avoid</h2>
                  <ul className="mt-2 list-inside list-disc text-sm text-amber-800">
                    {content.things_to_avoid.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {content.come_back_if.length > 0 && (
            <section className="rounded-lg border border-emergency-600/30 bg-red-50 p-5">
              <h2 className="font-medium text-emergency-700">Come back / seek care if</h2>
              <ul className="mt-2 list-inside list-disc text-sm text-emergency-700">
                {content.come_back_if.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </section>
          )}

          {content.next_appointment && (
            <p className="text-sm text-slate-600">Next appointment: {content.next_appointment}</p>
          )}

          {content.questions_you_might_have.length > 0 && (
            <section className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="font-medium text-slate-900">Questions you might have</h2>
              <div className="mt-3 space-y-3">
                {content.questions_you_might_have.map((qa, i) => (
                  <div key={i}>
                    <p className="text-sm font-medium text-slate-800">{qa.q}</p>
                    <p className="text-sm text-slate-600">{qa.a}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </PortalShell>
  );
}
