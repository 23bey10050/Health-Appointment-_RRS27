import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type { CalendarStatus } from "@/lib/types";

const QUERY_MESSAGE: Record<string, { text: string; tone: "success" | "error" }> = {
  connected: { text: "Google Calendar connected.", tone: "success" },
  error: { text: "Could not connect Google Calendar. Please try again.", tone: "error" },
  invalid_state: { text: "That connection link expired. Please try again.", tone: "error" },
};

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryResult = searchParams.get("calendar");
  const banner = queryResult ? QUERY_MESSAGE[queryResult] : null;

  async function loadStatus() {
    setLoading(true);
    try {
      const result = await apiFetch<CalendarStatus>("/api/v1/calendar/status");
      setStatus(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
    if (queryResult) {
      // Clear the query param once shown, so a refresh doesn't re-show a stale message.
      const next = new URLSearchParams(searchParams);
      next.delete("calendar");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ authorization_url: string | null; configured: boolean }>(
        "/api/v1/calendar/connect"
      );
      if (!result.configured || !result.authorization_url) {
        setError("Google Calendar isn't configured on this server yet (missing OAuth credentials).");
        return;
      }
      window.location.href = result.authorization_url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the connection.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/v1/calendar/disconnect", { method: "DELETE" });
      await loadStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PortalShell>
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>

      {banner && (
        <div
          className={`mt-4 rounded-md border p-3 text-sm ${
            banner.tone === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-emergency-600/30 bg-red-50 text-emergency-700"
          }`}
        >
          {banner.text}
        </div>
      )}

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="font-medium text-slate-900">Google Calendar</h2>
        <p className="mt-1 text-sm text-slate-500">
          Sync your confirmed appointments to your Google Calendar automatically.
        </p>

        {loading && <p className="mt-4 text-sm text-slate-500">Loading...</p>}
        {error && <p className="mt-4 text-sm text-emergency-600">{error}</p>}

        {!loading && status && (
          <div className="mt-4">
            {status.connected ? (
              <>
                <p className="text-sm text-green-700">
                  Connected{status.connected_at ? ` since ${new Date(status.connected_at).toLocaleDateString()}` : ""}.
                </p>
                <button
                  onClick={handleDisconnect}
                  disabled={busy}
                  className="mt-3 rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                onClick={handleConnect}
                disabled={busy}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? "Connecting..." : "Connect Google Calendar"}
              </button>
            )}
          </div>
        )}
      </div>
    </PortalShell>
  );
}
