import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { AdminHealthOut } from "@/lib/types";

const CIRCUIT_COLOR: Record<string, string> = {
  closed: "bg-green-100 text-green-700",
  half_open: "bg-amber-100 text-amber-700",
  open: "bg-red-100 text-emergency-700",
};

export function HealthDashboard() {
  const [health, setHealth] = useState<AdminHealthOut | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<AdminHealthOut>("/api/v1/admin/health")
      .then(setHealth)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-slate-500">Loading system health...</p>;
  if (!health) return null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase text-slate-500">Voice sessions</p>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{health.voice_sessions_total}</p>
        <p className="text-sm text-slate-500">
          {health.voice_sessions_emergency} emergency ({(health.red_flag_fire_rate * 100).toFixed(1)}%)
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase text-slate-500">Email outbox</p>
        <div className="mt-1 space-y-0.5 text-sm text-slate-700">
          {Object.keys(health.outbox_backlog).length === 0 && <p className="text-slate-400">No outbox activity yet.</p>}
          {Object.entries(health.outbox_backlog).map(([status, count]) => (
            <p key={status}>
              {status}: <span className="font-medium">{count}</span>
            </p>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase text-slate-500">Red-flag categories fired</p>
        <div className="mt-1 space-y-0.5 text-sm text-slate-700">
          {Object.keys(health.red_flag_categories).length === 0 && <p className="text-slate-400">None yet.</p>}
          {Object.entries(health.red_flag_categories).map(([cat, count]) => (
            <p key={cat}>
              {cat}: <span className="font-medium">{count}</span>
            </p>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:col-span-2">
        <p className="text-xs font-semibold uppercase text-slate-500">Voice pipeline latency (recent turns)</p>
        {health.voice_latency.length === 0 ? (
          <p className="mt-1 text-sm text-slate-400">No voice turns recorded yet.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400">
                <th className="pb-1">Stage</th>
                <th className="pb-1">p50</th>
                <th className="pb-1">p95</th>
                <th className="pb-1">n</th>
              </tr>
            </thead>
            <tbody>
              {health.voice_latency.map((s) => (
                <tr key={s.stage} className="border-t border-slate-100">
                  <td className="py-1 text-slate-700">{s.stage}</td>
                  <td className="py-1 text-slate-700">{s.p50_ms ?? "--"} ms</td>
                  <td className="py-1 text-slate-700">{s.p95_ms ?? "--"} ms</td>
                  <td className="py-1 text-slate-500">{s.sample_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:col-span-2 lg:col-span-3">
        <p className="text-xs font-semibold uppercase text-slate-500">LLM provider status</p>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400">
              <th className="pb-1">Tier</th>
              <th className="pb-1">Provider</th>
              <th className="pb-1">Model</th>
              <th className="pb-1">Circuit</th>
              <th className="pb-1">Requests (last min / today)</th>
            </tr>
          </thead>
          <tbody>
            {health.llm_provider_status.map((p, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1 text-slate-700">{p.tier}</td>
                <td className="py-1 text-slate-700">{p.provider}</td>
                <td className="py-1 text-slate-500">{p.model}</td>
                <td className="py-1">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CIRCUIT_COLOR[p.circuit_state]}`}>
                    {p.circuit_state}
                  </span>
                </td>
                <td className="py-1 text-slate-700">
                  {p.requests_last_minute}/{p.rpm_limit} min -- {p.requests_today}
                  {p.rpd_limit ? `/${p.rpd_limit}` : ""} today
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
