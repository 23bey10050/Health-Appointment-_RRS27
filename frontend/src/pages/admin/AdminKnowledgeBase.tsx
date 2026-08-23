import { useEffect, useState } from "react";
import { PortalShell } from "@/components/layout/PortalShell";
import { apiFetch, ApiError } from "@/lib/api";
import type { KBDocumentOut, KBDocumentUpload } from "@/lib/types";

const NAMESPACES = ["clinic_kb", "triage_kb", "clinical_kb", "patient_ctx"];
const AUDIENCES = ["patient", "doctor", "both"];

function emptyUpload(): KBDocumentUpload {
  return { namespace: "clinic_kb", audience: "both", title: "", source_type: "markdown", content: "" };
}

export default function AdminKnowledgeBase() {
  const [documents, setDocuments] = useState<KBDocumentOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<KBDocumentUpload>(emptyUpload());
  const [uploading, setUploading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setDocuments(await apiFetch<KBDocumentOut[]>("/api/v1/admin/kb/documents"));
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleUpload() {
    setUploading(true);
    setError(null);
    setMessage(null);
    try {
      const doc = await apiFetch<KBDocumentOut>("/api/v1/admin/kb/documents", { method: "POST", body: JSON.stringify(form) });
      setMessage(`Uploaded "${doc.title}" (${doc.chunk_count} chunks).`);
      setForm(emptyUpload());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload this document.");
    } finally {
      setUploading(false);
    }
  }

  async function handleReindexSeed() {
    setReindexing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiFetch<{ documents_reindexed: number; total_chunks: number }>(
        "/api/v1/admin/kb/reindex-seed",
        { method: "POST" }
      );
      setMessage(`Reindexed ${result.documents_reindexed} built-in documents (${result.total_chunks} chunks).`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reindex.");
    } finally {
      setReindexing(false);
    }
  }

  return (
    <PortalShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Knowledge base</h1>
        <button
          onClick={handleReindexSeed}
          disabled={reindexing}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
        >
          {reindexing ? "Reindexing..." : "Reindex built-in sources"}
        </button>
      </div>

      {message && <p className="mt-3 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-3 text-sm text-emergency-600">{error}</p>}

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="font-medium text-slate-900">Upload a markdown document</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="sm:col-span-3 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <select value={form.namespace} onChange={(e) => setForm({ ...form, namespace: e.target.value })} className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            {NAMESPACES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <textarea
          placeholder="Markdown content..."
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          rows={8}
          className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
        />
        <button
          onClick={handleUpload}
          disabled={uploading || !form.title || !form.content}
          className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </div>

      {loading && <p className="mt-4 text-sm text-slate-500">Loading...</p>}

      <div className="mt-6 space-y-2">
        {documents.map((doc) => (
          <div key={doc.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-900">{doc.title}</p>
                <p className="text-sm text-slate-500">
                  {doc.namespace} -- audience: {doc.audience} -- {doc.chunk_count} chunks -- v{doc.version}
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${doc.is_active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                {doc.is_active ? "active" : "inactive"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </PortalShell>
  );
}
