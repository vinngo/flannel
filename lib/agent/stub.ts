import "server-only";
import { getArtifactStore } from "../artifacts";
import type { AgentEvent } from "./events";
import type { Agent, AgentRunOptions } from "./types";

// Canned answers over made-up data. Tool names and shapes follow the spec's
// tool table so the UI is exercised the way the real agent will drive it.

const HOLDINGS = [
  { broker: "fidelity", account: "Roth IRA", ticker: "FXAIX", value: 48210.55 },
  { broker: "fidelity", account: "Brokerage", ticker: "VTI", value: 31877.1 },
  { broker: "robinhood", account: "Brokerage", ticker: "NVDA", value: 22940.0 },
  { broker: "robinhood", account: "Brokerage", ticker: "AAPL", value: 9815.42 },
  { broker: "fidelity", account: "Brokerage", ticker: "SPAXX", value: 6102.93 },
];

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

export class StubAgent implements Agent {
  async *run(question: string, { sessionId, signal }: AgentRunOptions): AsyncIterable<AgentEvent> {
    const asOf = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const q = question.toLowerCase();
    let toolSeq = 0;

    const tool = async function* (name: string, summary: string, input?: unknown): AsyncGenerator<AgentEvent> {
      const id = `t${++toolSeq}`;
      yield { type: "tool_start", id, name, input };
      await sleep(450, signal);
      yield { type: "tool_end", id, ok: true, summary };
    };

    const say = async function* (text: string): AsyncGenerator<AgentEvent> {
      for (const word of text.split(/(?<=\s)/)) {
        await sleep(25, signal);
        yield { type: "text", delta: word };
      }
    };

    yield* tool("snapshot_status", "latest snapshot 3h old", {});
    const total = HOLDINGS.reduce((s, h) => s + h.value, 0);

    if (/alloc|concentrat|weight|breakdown|diversif/.test(q)) {
      yield* tool("pull_holdings", `${HOLDINGS.length} rows → snapshots/…/holdings.csv`, {});
      yield* tool("load_snapshot", "holdings.csv copied into sandbox", { s3_key: "snapshots/latest/holdings.csv" });
      yield* tool("execute_code", "pandas: weights by ticker", { language: "python" });

      const rows = HOLDINGS.map((h) => ({ ...h, weight: h.value / total })).sort((a, b) => b.weight - a.weight);
      const csv = [
        "ticker,broker,account,market_value,weight",
        ...rows.map((r) => `${r.ticker},${r.broker},${r.account},${r.value.toFixed(2)},${r.weight.toFixed(4)}`),
      ].join("\n");
      const key = `sessions/${sessionId}/allocation.csv`;
      await getArtifactStore().put(key, csv, "text/csv");
      yield* tool("file_artifact", key, { path: "allocation.csv" });

      const pct = (w: number) => `${(w * 100).toFixed(1)}%`;
      const singleStocks = rows.filter((r) => r.ticker === "NVDA" || r.ticker === "AAPL");
      yield* say(
        `Your largest position is ${rows[0].ticker} at ${pct(rows[0].weight)} of ${usd(total)}. ` +
          `The top two holdings make up ${pct(rows[0].weight + rows[1].weight)} of the portfolio. ` +
          `Single-stock exposure (${singleStocks.map((r) => r.ticker).join(", ")}) is ` +
          `${pct(singleStocks.reduce((s, r) => s + r.weight, 0))}. The full breakdown is attached.`,
      );
      yield { type: "artifact", key, name: "allocation.csv", contentType: "text/csv" };
    } else if (/total|worth|value|balance/.test(q)) {
      yield* tool("portfolio_summary", `total ${usd(total)}`, {});
      yield* say(
        `Your portfolio is worth ${usd(total)} across Fidelity and Robinhood. ` +
          `This comes from the latest snapshot, so no sandbox math was needed.`,
      );
    } else {
      yield* say(
        "This is the stub agent, so I only know two tricks: ask for your total value, " +
          "or ask how concentrated your allocation is. The real agent replaces me in milestone 3.",
      );
    }

    yield { type: "done", asOf };
  }
}
