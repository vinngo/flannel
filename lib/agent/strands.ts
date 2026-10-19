import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { Agent, McpClient, type BaseModelConfig, type Model, type ToolList } from "@strands-agents/sdk";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { assertArtifactKey, getArtifactStore } from "../artifacts";
import { config } from "../config";
import { AgentCoreSandbox } from "../sandbox";
import { getSnapshotReader } from "../snapshots";
import type { AgentEvent } from "./events";
import { SYSTEM_PROMPT } from "./prompt";
import { sandboxTools } from "./sandbox-tools";
import type { Agent as FlannelAgent, AgentRunOptions } from "./types";

// Strands agent with Claude on Bedrock, calling the plaid-agent MCP tools and
// analyzing their snapshots in an AgentCore Code Interpreter sandbox.
// Claude calls go through the Anthropic SDK's Bedrock Mantle client; Strands'
// AnthropicModel only needs `messages.stream` / `messages.countTokens` from it.

// Sandbox answers take more steps: pull, load, one or two runs of code, file.
const MAX_TURNS = 14;
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

/** The tools for one run, plus how to release them when the run ends. */
export interface ToolSession {
  tools: ToolList;
  close(): Promise<void>;
}

/** The plaid-agent MCP tools plus a Code Interpreter sandbox scoped to this run. */
function defaultToolSession({ sessionId }: AgentRunOptions): ToolSession {
  const mcp = new McpClient({
    url: config.mcp.url,
    headers: config.mcp.apiKey ? { Authorization: `Bearer ${config.mcp.apiKey}` } : undefined,
  });
  const sandbox = new AgentCoreSandbox(`flannel-${sessionId}`);
  const tools = sandboxTools({ sandbox, snapshots: getSnapshotReader(), artifacts: getArtifactStore(), sessionId });
  return {
    tools: [mcp, ...tools],
    async close() {
      await Promise.allSettled([mcp.disconnect(), sandbox.close()]);
    },
  };
}

const isTimestamp = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The older of two refresh times; an answer is only as fresh as its oldest input. */
export function older(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) return a ?? b;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/**
 * The MCP tools return one text block of JSON. Every result carries
 * `data_as_of`: Plaid's oldest refresh time for the data it covers, or null.
 */
export interface ToolResultInfo {
  summary?: string;
  dataAsOf?: string;
  /** Set by file_artifact: a session file to show under the answer. */
  artifact?: { key: string; name: string; contentType: string };
}

function readArtifact(v: unknown): ToolResultInfo["artifact"] {
  const a = v as { key?: unknown; name?: unknown; content_type?: unknown } | undefined;
  if (typeof a?.key !== "string" || typeof a.name !== "string" || typeof a.content_type !== "string") return undefined;
  try {
    return { key: assertArtifactKey(a.key), name: a.name, contentType: a.content_type };
  } catch {
    return undefined;
  }
}

export function readToolResult(content: readonly { type: string }[]): ToolResultInfo {
  let dataAsOf: string | undefined;
  let summary: string | undefined;
  let artifact: ToolResultInfo["artifact"];
  for (const block of content) {
    if (block.type !== "textBlock") continue;
    const text = (block as unknown as { text: string }).text;
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (isTimestamp(data.data_as_of)) dataAsOf = older(dataAsOf, data.data_as_of);
      const s = data.summary ?? (data.error as { message?: string } | undefined)?.message;
      if (typeof s === "string") summary = s;
      artifact ??= readArtifact(data.artifact);
    } catch {
      summary ??= text;
    }
  }
  if (summary && summary.length > TOOL_SUMMARY_CHARS) summary = `${summary.slice(0, TOOL_SUMMARY_CHARS - 1)}…`;
  return { summary, dataAsOf, artifact };
}

function describeError(err: unknown): string {
  const name = (err as Error)?.name ?? "";
  if (name === "CredentialsProviderError" || /credential/i.test((err as Error)?.message ?? "")) {
    return "No AWS credentials found for Bedrock. Configure an AWS profile or AWS_* environment variables.";
  }
  if (/ECONNREFUSED|fetch failed|connect/i.test((err as Error)?.message ?? "")) {
    return `Couldn't reach the MCP server at ${config.mcp.url}. Is plaid-agent-mcp running (npm run dev)?`;
  }
  if (name === "AccessDeniedException") {
    return "AWS denied access to Bedrock or Code Interpreter. Check the IAM permissions for these credentials.";
  }
  return "The agent hit an error. Try again.";
}

export interface StrandsAgentDeps {
  model?: () => Model<BaseModelConfig>;
  /** A fresh tool session per run; defaults to the plaid-agent MCP server plus the sandbox. */
  tools?: (opts: AgentRunOptions) => ToolSession;
}

export class StrandsAgent implements FlannelAgent {
  private model: () => Model<BaseModelConfig>;
  private tools: (opts: AgentRunOptions) => ToolSession;

  /** Both are injectable so the event mapping can be tested without Bedrock or MCP. */
  constructor({ model = getModel, tools = defaultToolSession }: StrandsAgentDeps = {}) {
    this.model = model;
    this.tools = tools;
  }

  async *run(question: string, opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    const { signal } = opts;
    const session = this.tools(opts);
    const agent = new Agent({
      model: this.model(),
      tools: session.tools,
      systemPrompt: SYSTEM_PROMPT,
      printer: false,
    });

    let asOf: string | undefined;
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
            const result = readToolResult(ev.result.content);
            asOf = older(asOf, result.dataAsOf);
            const ok = ev.result.status === "success";
            yield { type: "tool_end", id: ev.toolUse.toolUseId, ok, summary: result.summary };
            if (ok && result.artifact) yield { type: "artifact", ...result.artifact };
            break;
          }
        }
      }
      yield { type: "done", asOf };
    } catch (err) {
      if (signal?.aborted) return;
      console.error("strands agent run failed", err);
      yield { type: "error", message: describeError(err) };
    } finally {
      await session.close().catch(() => {});
    }
  }
}
