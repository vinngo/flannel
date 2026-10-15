import "server-only";
import type { AgentEvent } from "./agent/events";

const encoder = new TextEncoder();

function frame(event: AgentEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Turns an agent event stream into an SSE body. Errors become a final
 * `error` event instead of a broken stream, and cancelling the response
 * (the browser went away) stops the iterator.
 */
export function toSSE(events: AsyncIterable<AgentEvent>): ReadableStream<Uint8Array> {
  const it = events[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(frame(value));
      } catch (err) {
        console.error("agent run failed", err);
        controller.enqueue(frame({ type: "error", message: "The agent hit an error. Try again." }));
        controller.close();
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};
