"use client";

import { useCallback, useEffect, useState } from "react";

type Doc = { id: string; name: string; mimeType: string; byteSize: number; chunkCount: number; createdAt: string; quarantined?: boolean };
type Log = {
  id: string;
  conversationId: string;
  question: string;
  answer: string;
  engine: string;
  grounded: boolean;
  usage: { promptTokens: number; completionTokens: number; costUsd: number; model: string; engine: string };
  createdAt: string;
};
type Summary = {
  conversations: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  byEngine: Record<string, { conversations: number; costUsd: number; tokens: number }>;
};

export default function AdminPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string>("");
  const [password, setPassword] = useState<string>("");

  // The token is per-process, so it only ever lives in this tab's memory — never
  // localStorage, never a URL. A reload asks for the password again.
  useEffect(() => {
    setToken(sessionStorage.getItem("admin_token") ?? "");
  }, []);

  const refresh = useCallback(async () => {
    const [docRes, logRes] = await Promise.all([
      fetch("/api/docs", { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
      fetch("/api/logs", { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    ]);
    if (docRes.status === 401 || logRes.status === 401) {
      setToken("");
      sessionStorage.removeItem("admin_token");
      setPassword("");
      return;
    }
    const docJson = (await docRes.json()) as { docs: Doc[] };
    const logJson = (await logRes.json()) as { logs: Log[]; summary: Summary };
    setDocs(docJson.docs ?? []);
    setLogs(logJson.logs ?? []);
    setSummary(logJson.summary ?? null);
  }, [token]);

  useEffect(() => {
    if (token) void refresh();
  }, [token, refresh]);

  async function login() {
    setStatus("");
    setBusy(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !json.token) throw new Error(json.error ?? "Login failed.");
      sessionStorage.setItem("admin_token", json.token);
      setToken(json.token);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setStatus("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/ingest", {
        method: "POST",
        body: form,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `Upload failed (${res.status})`);
      setStatus(json.message ?? "Indexed.");
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc(id: string) {
    setBusy(true);
    setStatus("");
    try {
      const res = await fetch(`/api/docs?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Delete failed");
      setStatus("Document deleted.");
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <main className="mx-auto max-w-sm px-4 py-24">
        <h1 className="text-2xl font-bold">Knowledge base admin</h1>
        <p className="mt-1 text-sm text-slate-600">Sign in to upload documents and read the conversation log.</p>
        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            autoFocus
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !password}
            className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Sign in
          </button>
        </form>
        {status && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{status}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Knowledge base admin</h1>
          <p className="mt-1 text-sm text-slate-600">Upload documents, watch usage, see what this assistant costs to run.</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/" className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-indigo-400">
            ← Chat
          </a>
          <button
            onClick={() => {
              sessionStorage.removeItem("admin_token");
              setToken("");
              setPassword("");
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-red-400"
          >
            Sign out
          </button>
        </div>
      </header>

      {status && <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{status}</p>}

      {/* ── documents ── */}
      <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Documents</h2>

        <label className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-600 hover:border-indigo-400">
          <span className="font-medium text-slate-800">Drop a .txt, .md or .pdf here</span>
          <span className="mt-1 text-xs text-slate-500">Max 5 MB. Indexed in seconds.</span>
          <input
            type="file"
            accept=".txt,.md,.markdown,.pdf"
            disabled={busy}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
        </label>

        {docs.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No documents yet — the demo corpus loads automatically.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {docs.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800">{doc.name}</p>
                  <p className="mt-2 text-xs text-slate-500">
                              {doc.chunkCount} sections · {(doc.byteSize / 1024).toFixed(1)} KB · {new Date(doc.createdAt).toLocaleString()}
                              {doc.quarantined && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-red-600">quarantined — excluded from answers</span>}
                            </p>
                </div>
                <button
                  onClick={() => void removeDoc(doc.id)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── cost ── */}
      <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Usage and cost</h2>
        {summary && summary.conversations > 0 ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Conversations" value={String(summary.conversations)} />
              <Stat label="Prompt tokens" value={summary.totalPromptTokens.toLocaleString()} />
              <Stat label="Completion tokens" value={summary.totalCompletionTokens.toLocaleString()} />
              <Stat label="Estimated cost" value={summary.totalCostUsd === 0 ? "$0.00" : `$${summary.totalCostUsd.toFixed(4)}`} />
            </div>
            <div className="mt-3 text-xs text-slate-500">
              {Object.entries(summary.byEngine)
                .map(([engine, s]) => `${engine}: ${s.conversations} conv · ${s.tokens.toLocaleString()} tokens · $${s.costUsd.toFixed(4)}`)
                .join("  ·  ")}
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm text-slate-500">No conversations logged yet. Ask the chat a question first.</p>
        )}
      </section>

      {/* ── logs ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Conversation log</h2>
          {logs.length > 0 && (
            <button
              onClick={() => {
                void fetch("/api/logs", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).then(refresh);
              }}
              className="text-xs text-slate-500 hover:text-red-600"
            >
              Clear log
            </button>
          )}
        </div>

        {logs.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Nothing logged yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {logs.map((log) => (
              <li key={log.id} className="rounded-xl border border-slate-100 p-3 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <p className="font-medium text-slate-800">{log.question}</p>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      log.grounded ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {log.grounded ? "answered" : "refused"}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-slate-600">{log.answer}</p>
                <p className="mt-2 text-xs text-slate-400">
                  {log.usage.engine} · {log.usage.model} · {log.usage.promptTokens} in / {log.usage.completionTokens} out · $
                  {log.usage.costUsd.toFixed(4)} · {new Date(log.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}
