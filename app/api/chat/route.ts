import { z } from "zod";
import { getAgent } from "@/lib/agent";
import { SSE_HEADERS, toSSE } from "@/lib/sse";

const Body = z.object({ question: z.string().trim().min(1).max(4000) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Body must be {question: string}" }, { status: 400 });
  }

  const sessionId = crypto.randomUUID();
  const agent = getAgent();

  async function* events() {
    yield { type: "session" as const, sessionId };
    yield* agent.run(parsed.data!.question, { sessionId, signal: req.signal });
  }

  return new Response(toSSE(events()), { headers: SSE_HEADERS });
}
