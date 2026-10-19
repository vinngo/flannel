import { Model, tool, type ModelStreamEvent } from "@strands-agents/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "./events";
import { older, readToolResult, StrandsAgent, type ToolSession } from "./strands";

// The real StrandsAgent and Strands loop, with a scripted model and local tools
// that return the same JSON text the plaid-agent MCP tools do.

type Turn = { text?: string; tools?: string[] };

/** Plays back one turn per model call: optional text, then optional parallel tool calls. */
class ScriptedModel extends Model {
  private turn = 0;
  constructor(private turns: Turn[]) {
    super();
  }
  updateConfig() {}
  getConfig() {
    return { modelId: "scripted" };
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    const { text, tools = [] } = this.turns[this.turn++] ?? { text: "(out of script)" };
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if (text) {
      yield { type: "modelContentBlockStartEvent" };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text } };
      yield { type: "modelContentBlockStopEvent" };
    }
    for (const [i, name] of tools.entries()) {
      yield { type: "modelContentBlockStartEvent", start: { type: "toolUseStart", name, toolUseId: `t${this.turn}-${i}` } };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "toolUseInputDelta", input: "{}" } };
      yield { type: "modelContentBlockStopEvent" };
    }
    yield { type: "modelMessageStopEvent", stopReason: tools.length ? "toolUse" : "endTurn" };
  }
}

class FailingModel extends Model {
  updateConfig() {}
  getConfig() {
    return { modelId: "failing" };
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    throw new Error("Bedrock is down");
  }
}

/** Local tools answering with fixed MCP-shaped payloads; records whether the session was closed. */
function fakeTools(payloads: Record<string, unknown>): ToolSession & { closed: boolean } {
  const session = {
    closed: false,
    tools: Object.entries(payloads).map(([name, payload]) =>
      tool({ name, description: name, inputSchema: z.object({}), callback: () => JSON.stringify(payload) }),
    ),
    async close() {
      session.closed = true;
    },
  };
  return session;
}

async function run(turns: Turn[], payloads: Record<string, unknown>) {
  const session = fakeTools(payloads);
  const agent = new StrandsAgent({ model: () => new ScriptedModel(turns), tools: () => session });
  const events: AgentEvent[] = [];
  for await (const ev of agent.run("question", { sessionId: "test" })) events.push(ev);
  return { events, session };
}

const FIDELITY = "2026-10-19T08:00:00.000Z";
const ROBINHOOD = "2026-10-19T14:00:00.000Z";

describe("StrandsAgent", () => {
  it("maps a tool round trip onto AgentEvents", async () => {
    const { events, session } = await run(
      [{ text: "Checking.", tools: ["portfolio_summary"] }, { text: "You have $100." }],
      { portfolio_summary: { summary: "Total $100.", data_as_of: FIDELITY } },
    );

    expect(events).toEqual([
      { type: "text", delta: "Checking." },
      { type: "tool_start", id: "t1-0", name: "portfolio_summary", input: {} },
      { type: "tool_end", id: "t1-0", ok: true, summary: "Total $100." },
      // Text from a later model turn starts a new paragraph.
      { type: "text", delta: "\n\nYou have $100." },
      { type: "done", asOf: FIDELITY },
    ]);
    expect(session.closed).toBe(true);
  });

  it("reports the oldest data_as_of across all tool calls", async () => {
    const { events } = await run([{ tools: ["snapshot_status", "portfolio_summary"] }, { text: "Done." }], {
      snapshot_status: { summary: "fresh", data_as_of: ROBINHOOD },
      portfolio_summary: { summary: "Total", data_as_of: FIDELITY },
    });
    expect(events.at(-1)).toEqual({ type: "done", asOf: FIDELITY });
  });

  it("leaves asOf unset when no tool knows Plaid's refresh time", async () => {
    const { events } = await run([{ tools: ["pull_transactions"] }, { text: "Done." }], {
      pull_transactions: { s3_key: "snapshots/x/transactions.csv", data_as_of: null, pulled_at: ROBINHOOD },
    });
    // The pull time must never stand in for a refresh time.
    expect(events.at(-1)).toEqual({ type: "done", asOf: undefined });
  });

  it("emits an artifact event when file_artifact succeeds", async () => {
    const key = "sessions/test/weights.csv";
    const { events } = await run([{ tools: ["file_artifact"] }, { text: "Attached." }], {
      file_artifact: { s3_key: key, summary: key, artifact: { key, name: "weights.csv", content_type: "text/csv" } },
    });
    expect(events.slice(0, 3)).toEqual([
      { type: "tool_start", id: "t1-0", name: "file_artifact", input: {} },
      { type: "tool_end", id: "t1-0", ok: true, summary: key },
      { type: "artifact", key, name: "weights.csv", contentType: "text/csv" },
    ]);
  });

  it("passes the run's session id to the tool factory", async () => {
    const seen: string[] = [];
    const agent = new StrandsAgent({
      model: () => new ScriptedModel([{ text: "Hi." }]),
      tools: ({ sessionId }) => {
        seen.push(sessionId);
        return fakeTools({});
      },
    });
    for await (const _ of agent.run("question", { sessionId: "abc" })) void _;
    expect(seen).toEqual(["abc"]);
  });

  it("turns a model failure into an error event and still closes the tools", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const session = fakeTools({});
    const agent = new StrandsAgent({ model: () => new FailingModel(), tools: () => session });
    const events: AgentEvent[] = [];
    for await (const ev of agent.run("question", { sessionId: "test" })) events.push(ev);

    expect(events).toEqual([{ type: "error", message: "The agent hit an error. Try again." }]);
    expect(session.closed).toBe(true);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

describe("readToolResult", () => {
  const text = (value: unknown) => [{ type: "textBlock", text: typeof value === "string" ? value : JSON.stringify(value) }];

  it("reads summary and data_as_of", () => {
    expect(readToolResult(text({ summary: "ok", data_as_of: FIDELITY }))).toEqual({ summary: "ok", dataAsOf: FIDELITY });
  });

  it("ignores null, missing and invalid data_as_of", () => {
    expect(readToolResult(text({ summary: "a", data_as_of: null })).dataAsOf).toBeUndefined();
    expect(readToolResult(text({ summary: "b" })).dataAsOf).toBeUndefined();
    expect(readToolResult(text({ summary: "c", data_as_of: "yesterday-ish" })).dataAsOf).toBeUndefined();
  });

  it("does not pick up as_of fields other than data_as_of", () => {
    const result = readToolResult(text({ summary: "s", as_of: FIDELITY, as_of_by_broker: { fidelity: FIDELITY } }));
    expect(result.dataAsOf).toBeUndefined();
  });

  it("uses an error message as the summary", () => {
    expect(readToolResult(text({ error: { message: "No holdings found." } })).summary).toBe("No holdings found.");
  });

  it("falls back to the raw text when it isn't JSON", () => {
    expect(readToolResult(text("plain text result")).summary).toBe("plain text result");
  });

  it("truncates long summaries", () => {
    const { summary } = readToolResult(text({ summary: "x".repeat(500) }));
    expect(summary).toHaveLength(140);
    expect(summary?.endsWith("…")).toBe(true);
  });

  it("skips non-text blocks", () => {
    expect(readToolResult([{ type: "jsonBlock" }])).toEqual({ summary: undefined, dataAsOf: undefined });
  });

  it("reads an artifact only under the session prefix", () => {
    const artifact = (key: string) => text({ summary: "s", artifact: { key, name: "a.csv", content_type: "text/csv" } });
    expect(readToolResult(artifact("sessions/x/a.csv")).artifact).toEqual({
      key: "sessions/x/a.csv",
      name: "a.csv",
      contentType: "text/csv",
    });
    expect(readToolResult(artifact("snapshots/x/holdings.csv")).artifact).toBeUndefined();
    expect(readToolResult(artifact("sessions/../latest.json")).artifact).toBeUndefined();
  });
});

describe("older", () => {
  it("returns the earlier timestamp, comparing as dates", () => {
    expect(older(ROBINHOOD, FIDELITY)).toBe(FIDELITY);
    expect(older(FIDELITY, ROBINHOOD)).toBe(FIDELITY);
    // Same instant, different offsets: string order would pick wrongly.
    expect(older("2026-10-19T09:00:00+02:00", "2026-10-19T08:00:00Z")).toBe("2026-10-19T09:00:00+02:00");
  });

  it("returns whichever side is set", () => {
    expect(older(undefined, FIDELITY)).toBe(FIDELITY);
    expect(older(FIDELITY, undefined)).toBe(FIDELITY);
    expect(older(undefined, undefined)).toBeUndefined();
  });
});
