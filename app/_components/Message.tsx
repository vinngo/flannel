"use client";

import { useEffect, useState } from "react";

export interface ToolCall {
  id: string;
  name: string;
  status: "running" | "ok" | "failed";
  summary?: string;
}

export interface Artifact {
  key: string;
  name: string;
  contentType: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools: ToolCall[];
  artifacts: Artifact[];
  sessionId?: string;
  pending?: boolean;
  asOf?: string;
  error?: string;
}

const STATUS_ICON = { running: "◌", ok: "✓", failed: "✕" } as const;

function formatAsOf(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function Message({ message: m }: { message: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-subtle px-4 py-2 whitespace-pre-wrap">{m.text}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {m.tools.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {m.tools.map((t) => (
            <li
              key={t.id}
              title={t.summary}
              className="flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 font-mono text-xs text-muted"
            >
              <span className={t.status === "running" ? "animate-spin" : t.status === "failed" ? "text-danger" : "text-ok"}>
                {STATUS_ICON[t.status]}
              </span>
              {t.name}
            </li>
          ))}
        </ul>
      )}

      {(m.text || m.pending) && (
        <p className="leading-relaxed whitespace-pre-wrap">
          {m.text}
          {m.pending && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60 align-middle" />}
        </p>
      )}

      {m.artifacts.map((a) => (
        <ArtifactCard key={a.key} artifact={a} />
      ))}

      {m.error && <p className="text-sm text-danger">{m.error}</p>}
      {m.asOf && <p className="text-xs text-muted">Data as of {formatAsOf(m.asOf)}</p>}
    </div>
  );
}

function parseCsv(text: string): string[][] {
  // Agent CSVs are simple (no quoted commas); good enough for a preview.
  return text.trim().split("\n").map((line) => line.split(","));
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [url, setUrl] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/artifacts?key=${encodeURIComponent(artifact.key)}`);
        const body = (await res.json()) as { url?: string; error?: string };
        if (!body.url) throw new Error(body.error ?? "No URL");
        if (cancelled) return;
        setUrl(body.url);
        if (artifact.contentType.startsWith("text/csv")) {
          const csv = await fetch(body.url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))));
          if (!cancelled) setRows(parseCsv(csv).slice(0, 21));
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact.key, artifact.contentType]);

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-subtle px-3 py-2 text-sm">
        <span className="font-mono">{artifact.name}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Open
          </a>
        )}
      </div>
      {error && <p className="px-3 py-2 text-sm text-danger">Couldn&apos;t load preview: {error}</p>}
      {rows && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {rows[0].map((h, i) => (
                  <th key={i} className="px-3 py-1.5 text-left font-medium text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {rows.slice(1).map((r, i) => (
                <tr key={i} className="border-t border-line">
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-1.5">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {url && artifact.contentType.startsWith("image/") && (
        // eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived URL
        <img src={url} alt={artifact.name} className="w-full" />
      )}
    </div>
  );
}
