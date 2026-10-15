import type { AgentEvent } from "./events";

export interface AgentRunOptions {
  sessionId: string;
  signal?: AbortSignal;
}

/** One-shot Q&A: no history is passed in v1. */
export interface Agent {
  run(question: string, opts: AgentRunOptions): AsyncIterable<AgentEvent>;
}
