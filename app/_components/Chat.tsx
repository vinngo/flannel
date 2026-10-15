"use client";

import { useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent/events";
import { Message, type ChatMessage } from "./Message";

const SUGGESTIONS = ["What's my total value?", "How concentrated is my allocation?"];

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as AgentEvent;
    }
  }
}

function apply(msg: ChatMessage, ev: AgentEvent): ChatMessage {
  switch (ev.type) {
    case "session":
      return { ...msg, sessionId: ev.sessionId };
    case "text":
      return { ...msg, text: msg.text + ev.delta };
    case "tool_start":
      return { ...msg, tools: [...msg.tools, { id: ev.id, name: ev.name, status: "running" }] };
    case "tool_end":
      return {
        ...msg,
        tools: msg.tools.map((t) =>
          t.id === ev.id ? { ...t, status: ev.ok ? "ok" : "failed", summary: ev.summary } : t,
        ),
      };
    case "artifact":
      return { ...msg, artifacts: [...msg.artifacts, { key: ev.key, name: ev.name, contentType: ev.contentType }] };
    case "done":
      return { ...msg, pending: false, asOf: ev.asOf };
    case "error":
      return { ...msg, pending: false, error: ev.message };
  }
}

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);

  async function ask(question: string) {
    question = question.trim();
    if (!question || busy) return;
    setBusy(true);
    setInput("");
    setMessages((ms) => [
      ...ms,
      { role: "user", text: question, tools: [], artifacts: [] },
      { role: "assistant", text: "", tools: [], artifacts: [], pending: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
      for await (const ev of readSSE(res.body)) {
        updateLast((m) => apply(m, ev));
        bottomRef.current?.scrollIntoView({ block: "end" });
      }
      updateLast((m) => (m.pending ? { ...m, pending: false, error: "The answer ended early." } : m));
    } catch (err) {
      updateLast((m) => ({ ...m, pending: false, error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
      <div className="flex-1 space-y-6 py-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-start gap-3 pt-16">
            <h1 className="text-2xl font-semibold tracking-tight">Ask about your portfolio</h1>
            <p className="text-sm text-muted">
              Read-only answers over your Fidelity and Robinhood accounts. Every answer says how fresh its data is.
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  className="rounded-full border border-line px-3 py-1.5 text-sm hover:bg-subtle"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="sticky bottom-0 bg-background pb-4 pt-2"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 shadow-sm">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={1}
            placeholder="Ask a question…"
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-xl bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40"
          >
            {busy ? "…" : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}
