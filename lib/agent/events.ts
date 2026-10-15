// The SSE contract between the chat route and the UI. Agent adapters (the
// stub now, Strands on AgentCore later) translate their own stream into these.
// Safe to import from client components: types only.

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary?: string }
  | { type: "artifact"; key: string; name: string; contentType: string }
  | { type: "done"; asOf?: string }
  | { type: "error"; message: string };
