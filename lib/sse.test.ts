import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./agent/events";
import { toSSE } from "./sse";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** The `data:` payloads of an SSE body, parsed back into events. */
function parseFrames(body: string): AgentEvent[] {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as AgentEvent);
}

describe("toSSE", () => {
  it("writes one data frame per event and then closes", async () => {
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "text", delta: "Hello" };
      yield { type: "done", asOf: "2026-10-19T08:00:00.000Z" };
    }
    const body = await readAll(toSSE(events()));

    expect(body).toBe(
      'data: {"type":"text","delta":"Hello"}\n\n' + 'data: {"type":"done","asOf":"2026-10-19T08:00:00.000Z"}\n\n',
    );
  });

  it("ends with an error event instead of a broken stream when the agent throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "text", delta: "Partial" };
      throw new Error("boom");
    }
    const frames = parseFrames(await readAll(toSSE(events())));

    expect(frames).toEqual([
      { type: "text", delta: "Partial" },
      { type: "error", message: "The agent hit an error. Try again." },
    ]);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("stops the agent when the client goes away", async () => {
    let finished = false;
    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        yield { type: "text", delta: "one" };
        yield { type: "text", delta: "two" };
      } finally {
        finished = true;
      }
    }
    const reader = toSSE(events()).getReader();
    await reader.read();
    await reader.cancel();

    expect(finished).toBe(true);
  });
});
