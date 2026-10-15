"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";

type Status =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready" }
  | { kind: "linking" }
  | { kind: "linked"; institution: string }
  | { kind: "error"; message: string };

export function LinkAccount() {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/plaid/link-token", { method: "POST" })
      .then(async (res) => {
        const body = (await res.json()) as { linkToken?: string; error?: string };
        if (body.linkToken) {
          setLinkToken(body.linkToken);
          setStatus({ kind: "ready" });
        } else {
          setStatus({ kind: "unavailable", reason: body.error ?? "Plaid Link is unavailable." });
        }
      })
      .catch(() => setStatus({ kind: "unavailable", reason: "Could not reach the server." }));
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(async (publicToken, metadata) => {
    setStatus({ kind: "linking" });
    const inst = metadata.institution;
    const res = await fetch("/api/plaid/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicToken, institution: inst ? { name: inst.name, id: inst.institution_id } : null }),
    });
    const body = (await res.json()) as { institution?: string; error?: string };
    setStatus(
      res.ok && body.institution
        ? { kind: "linked", institution: body.institution }
        : { kind: "error", message: body.error ?? "Linking failed." },
    );
  }, []);

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess });

  const note =
    status.kind === "linked"
      ? `Linked ${status.institution}`
      : status.kind === "error"
        ? status.message
        : status.kind === "linking"
          ? "Saving…"
          : null;

  return (
    <div className="flex items-center gap-3">
      {note && (
        <span className={`text-sm ${status.kind === "error" ? "text-danger" : "text-muted"}`} role="status">
          {note}
        </span>
      )}
      <button
        onClick={() => open()}
        disabled={!ready || status.kind === "unavailable" || status.kind === "linking"}
        title={status.kind === "unavailable" ? status.reason : undefined}
        className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      >
        Link account
      </button>
    </div>
  );
}
