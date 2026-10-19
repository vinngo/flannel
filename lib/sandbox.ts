import "server-only";
import {
  BedrockAgentCoreClient,
  InvokeCodeInterpreterCommand,
  StartCodeInterpreterSessionCommand,
  StopCodeInterpreterSessionCommand,
  type CodeInterpreterResult,
  type ToolArguments,
  type ToolName,
} from "@aws-sdk/client-bedrock-agentcore";
import { config } from "./config";

// One AgentCore Code Interpreter session per agent run. The session starts on
// the first call, so answers that never touch the sandbox don't pay for one.
// We call the service directly rather than through bedrock-agentcore's helper,
// which flattens file reads into strings and loses binary files like charts.

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
  isError: boolean;
}

export interface SandboxFile {
  path: string;
  bytes: Uint8Array;
  mimeType?: string;
}

export interface SandboxEntry {
  name: string;
  path: string;
  size?: number;
}

export interface Sandbox {
  executeCode(code: string): Promise<ExecResult>;
  writeFiles(files: { path: string; text: string }[]): Promise<void>;
  readFiles(paths: string[]): Promise<SandboxFile[]>;
  listFiles(path: string): Promise<SandboxEntry[]>;
  /** Stops the session if one was started. */
  close(): Promise<void>;
}

export class SandboxError extends Error {}

let sharedClient: BedrockAgentCoreClient | null = null;

function getClient(): BedrockAgentCoreClient {
  sharedClient ??= new BedrockAgentCoreClient({ region: config.codeInterpreter.region });
  return sharedClient;
}

/** The part of BedrockAgentCoreClient this uses; injectable for tests. */
export type SandboxClient = Pick<BedrockAgentCoreClient, "send">;

export interface AgentCoreSandboxOptions {
  client?: SandboxClient;
  identifier?: string;
  timeoutSeconds?: number;
}

const text = (s: string | undefined) => s ?? "";

/** Text of every text block, for error messages and stdout fallbacks. */
function joinText(result: CodeInterpreterResult): string {
  return (result.content ?? []).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
}

export class AgentCoreSandbox implements Sandbox {
  private sessionId: Promise<string> | null = null;
  private client: SandboxClient;
  private identifier: string;
  private timeoutSeconds: number;

  constructor(
    private name: string,
    {
      client = getClient(),
      identifier = config.codeInterpreter.identifier,
      timeoutSeconds = config.codeInterpreter.timeoutSeconds,
    }: AgentCoreSandboxOptions = {},
  ) {
    this.client = client;
    this.identifier = identifier;
    this.timeoutSeconds = timeoutSeconds;
  }

  private session(): Promise<string> {
    this.sessionId ??= this.client
      .send(
        new StartCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: this.identifier,
          name: this.name,
          sessionTimeoutSeconds: this.timeoutSeconds,
        }),
      )
      .then((res) => {
        if (!res.sessionId) throw new SandboxError("Code Interpreter returned no session id.");
        return res.sessionId;
      });
    return this.sessionId;
  }

  private async invoke(name: ToolName, args: ToolArguments): Promise<CodeInterpreterResult> {
    const sessionId = await this.session();
    const res = await this.client.send(
      new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: this.identifier, sessionId, name, arguments: args }),
    );
    let result: CodeInterpreterResult | undefined;
    for await (const ev of res.stream ?? []) {
      if (ev.result) result = ev.result;
      const failure = Object.values(ev).find((v): v is { message?: string } => v instanceof Error);
      if (failure) throw new SandboxError(failure.message ?? `Code Interpreter ${name} failed.`);
    }
    if (!result) throw new SandboxError(`Code Interpreter ${name} returned no result.`);
    return result;
  }

  async executeCode(code: string): Promise<ExecResult> {
    const result = await this.invoke("executeCode", { code, language: "python" });
    const s = result.structuredContent;
    return {
      stdout: s ? text(s.stdout) : joinText(result),
      stderr: text(s?.stderr),
      exitCode: s?.exitCode,
      isError: Boolean(result.isError) || (s?.exitCode ?? 0) !== 0,
    };
  }

  async writeFiles(files: { path: string; text: string }[]): Promise<void> {
    const result = await this.invoke("writeFiles", { content: files.map((f) => ({ path: f.path, text: f.text })) });
    if (result.isError) throw new SandboxError(joinText(result) || "Writing files to the sandbox failed.");
  }

  async readFiles(paths: string[]): Promise<SandboxFile[]> {
    const result = await this.invoke("readFiles", { paths });
    if (result.isError) throw new SandboxError(joinText(result) || "Reading files from the sandbox failed.");
    return (result.content ?? []).flatMap((b) => {
      const r = b.resource;
      if (b.type !== "resource" || !r) return [];
      const bytes = r.blob ?? new TextEncoder().encode(text(r.text));
      return [{ path: (r.uri ?? "").replace(/^file:\/\//, ""), bytes, mimeType: r.mimeType }];
    });
  }

  async listFiles(path: string): Promise<SandboxEntry[]> {
    const result = await this.invoke("listFiles", { directoryPath: path });
    if (result.isError) throw new SandboxError(joinText(result) || "Listing sandbox files failed.");
    return (result.content ?? []).flatMap((b) =>
      b.type === "resource_link" ? [{ name: text(b.name), path: (b.uri ?? "").replace(/^file:\/\//, ""), size: b.size }] : [],
    );
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = await this.sessionId.catch(() => null);
    this.sessionId = null;
    if (!sessionId) return;
    await this.client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: this.identifier, sessionId }));
  }
}
