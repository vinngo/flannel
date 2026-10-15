import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { Agent, McpClient, type BaseModelConfig, type Model } from "@strands-agents/sdk";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { config } from "../config";
import type { AgentEvent } from "./events";
import { SYSTEM_PROMPT } from "./prompt";
import type { Agent as FlannelAgent, AgentRunOptions } from "./types";

// Strands agent with Claude on Bedrock, calling the plaid-agent MCP tools.
// Claude calls go through the Anthropic SDK's Bedrock Mantle client; Strands'
// AnthropicModel only needs `messages.stream` / `messages.countTokens` from it.

const MAX_TURNS = 8;
const TOOL_SUMMARY_CHARS = 140;

let model: AnthropicModel | null = null;

function getModel(): AnthropicModel {
  if (!model) {
    const client = new AnthropicBedrockMantle({ awsRegion: config.bedrock.region });
    model = new AnthropicModel({
      // Mantle shares the Messages surface but is typed against a newer SDK
      // than the one Strands bundles.
      client: client as unknown as Anthropic,
      modelId: config.bedrock.modelId,
      maxTokens: 16000,
      params: { output_config: { effort: config.bedrock.effort } },
    });
  }
  return model;
}

function newMcpClient(): McpClient {
  return new McpClient({
    url: config.mcp.url,
    headers: config.mcp.apiKey ? { Authorization: `Bearer ${config.mcp.apiKey}` } : undefined,
  });
}

const isTimestamp = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** All `as_of` values anywhere in a tool's JSON output, including `as_of_by_broker` maps. */
function collectAsOf(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectAsOf(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "as_of" && isTimestamp(v)) out.push(v);
      else if (k === "as_of_by_broker" && v && typeof v === "object") out.push(...Object.values(v).filter(isTimestamp));
      else collectAsOf(v, out);
    }
  }
}

/** The MCP tools return one text block of JSON; pull out the summary and as_of values. */
function readToolResult(content: readonly { type: string }[]): { summary?: string; asOf: string[] } {
  const asOf: string[] = [];
  let summary: string | undefined;
  for (const block of content) {
    if (block.type !== "textBlock") continue;
    const text = (block as unknown as { text: string }).text;
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      collectAsOf(data, asOf);
      const s = data.summary ?? (data.error as { message?: string } | undefined)?.message;
      if (typeof s === "string") summary = s;
    } catch {
      summary ??= text;
    }
  }
  if (summary && summary.length > TOOL_SUMMARY_CHARS) summary = `${summary.slice(0, TOOL_SUMMARY_CHARS - 1)}…`;
  return { summary, asOf };
}

function describeError(err: unknown): string {
  const name = (err as Error)?.name ?? "";
  if (name === "CredentialsProviderError" || /credential/i.test((err as Error)?.message ?? "")) {
    return "No AWS credentials found for Bedrock. Configure an AWS profile or AWS_* environment variables.";
  }
  if (/ECONNREFUSED|fetch failed|connect/i.test((err as Error)?.message ?? "")) {
    return `Couldn't reach the MCP server at ${config.mcp.url}. Is plaid-agent-mcp running (npm run dev)?`;
  }
  return "The agent hit an error. Try again.";
}

export class StrandsAgent implements FlannelAgent {
  /** `model` is injectable so the event mapping can be exercised without Bedrock. */
  constructor(private model: () => Model<BaseModelConfig> = getModel) {}

  async *run(question: string, { signal }: AgentRunOptions): AsyncIterable<AgentEvent> {
    const mcp = newMcpClient();
    const agent = new Agent({
      model: this.model(),
      tools: [mcp],
      systemPrompt: SYSTEM_PROMPT,
      printer: false,
    });

    const asOfSeen: string[] = [];
    let wroteText = false;
    let needsBreak = false;

    try {
      for await (const ev of agent.stream(question, { cancelSignal: signal, limits: { turns: MAX_TURNS } })) {
        switch (ev.type) {
          case "modelStreamUpdateEvent": {
            const e = ev.event;
            if (e.type === "modelContentBlockDeltaEvent" && e.delta.type === "textDelta" && e.delta.text) {
              // Text from separate model turns (before and after tool calls) reads as separate paragraphs.
              const delta = needsBreak && wroteText ? `\n\n${e.delta.text}` : e.delta.text;
              needsBreak = false;
              wroteText = true;
              yield { type: "text", delta };
            }
            break;
          }
          case "beforeToolCallEvent":
            needsBreak = true;
            yield { type: "tool_start", id: ev.toolUse.toolUseId, name: ev.toolUse.name, input: ev.toolUse.input };
            break;
          case "afterToolCallEvent": {
            const { summary, asOf } = readToolResult(ev.result.content);
            asOfSeen.push(...asOf);
            yield { type: "tool_end", id: ev.toolUse.toolUseId, ok: ev.result.status === "success", summary };
            break;
          }
        }
      }
      // An answer is only as fresh as its oldest input.
      asOfSeen.sort();
      yield { type: "done", asOf: asOfSeen[0] };
    } catch (err) {
      if (signal?.aborted) return;
      console.error("strands agent run failed", err);
      yield { type: "error", message: describeError(err) };
    } finally {
      await mcp.disconnect().catch(() => {});
    }
  }
}
