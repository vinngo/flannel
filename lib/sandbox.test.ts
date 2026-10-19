import {
  InvokeCodeInterpreterCommand,
  StartCodeInterpreterSessionCommand,
  StopCodeInterpreterSessionCommand,
  type CodeInterpreterResult,
} from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it } from "vitest";
import { AgentCoreSandbox, SandboxError, type SandboxClient } from "./sandbox";

// AgentCoreSandbox against a fake AgentCore client that answers each invoke
// with a scripted result stream, shaped like the service's responses.

type Reply = CodeInterpreterResult | Error;

function fakeClient(replies: Reply[]) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    async send(cmd: { input: Record<string, unknown> }) {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd instanceof StartCodeInterpreterSessionCommand) return { sessionId: "sess-1" };
      if (cmd instanceof StopCodeInterpreterSessionCommand) return {};
      if (cmd instanceof InvokeCodeInterpreterCommand) {
        const reply = replies.shift();
        return {
          stream: (async function* () {
            if (reply instanceof Error) yield { throttlingException: reply };
            else yield { result: reply };
          })(),
        };
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    },
  };
  return { client: client as unknown as SandboxClient, sent };
}

describe("AgentCoreSandbox", () => {
  it("starts one session lazily, with the timeout, and stops it on close", async () => {
    const { client, sent } = fakeClient([
      { content: [], structuredContent: { stdout: "1\n", stderr: "", exitCode: 0 } },
      { content: [], structuredContent: { stdout: "2\n", stderr: "", exitCode: 0 } },
    ]);
    const sandbox = new AgentCoreSandbox("flannel-x", { client, identifier: "ci-1", timeoutSeconds: 300 });
    await sandbox.close(); // nothing started yet: no calls
    expect(sent).toEqual([]);

    await sandbox.executeCode("print(1)");
    await sandbox.executeCode("print(2)");
    await sandbox.close();

    expect(sent.map((s) => s.name)).toEqual([
      "StartCodeInterpreterSessionCommand",
      "InvokeCodeInterpreterCommand",
      "InvokeCodeInterpreterCommand",
      "StopCodeInterpreterSessionCommand",
    ]);
    expect(sent[0].input).toMatchObject({ codeInterpreterIdentifier: "ci-1", name: "flannel-x", sessionTimeoutSeconds: 300 });
    expect(sent[1].input).toMatchObject({ sessionId: "sess-1", name: "executeCode", arguments: { code: "print(1)", language: "python" } });
    expect(sent[3].input).toMatchObject({ codeInterpreterIdentifier: "ci-1", sessionId: "sess-1" });
  });

  it("reports a non-zero exit as an error with stderr", async () => {
    const { client } = fakeClient([
      { content: [], isError: true, structuredContent: { stdout: "", stderr: "KeyError: 'value'", exitCode: 1 } },
    ]);
    const r = await new AgentCoreSandbox("t", { client }).executeCode("df['value']");
    expect(r).toEqual({ stdout: "", stderr: "KeyError: 'value'", exitCode: 1, isError: true });
  });

  it("falls back to text blocks when there is no structured content", async () => {
    const { client } = fakeClient([{ content: [{ type: "text", text: "hello" }] }]);
    const r = await new AgentCoreSandbox("t", { client }).executeCode("print('hello')");
    expect(r).toEqual({ stdout: "hello", stderr: "", exitCode: undefined, isError: false });
  });

  it("reads text and binary files as bytes", async () => {
    const png = new Uint8Array([0x89, 0x50]);
    const { client } = fakeClient([
      {
        content: [
          { type: "resource", resource: { type: "text", uri: "file:///w/a.csv", text: "a,b\n" } },
          { type: "resource", resource: { type: "blob", uri: "file:///w/c.png", mimeType: "image/png", blob: png } },
        ],
      },
    ]);
    const files = await new AgentCoreSandbox("t", { client }).readFiles(["a.csv", "c.png"]);
    expect(files).toEqual([
      { path: "/w/a.csv", bytes: new TextEncoder().encode("a,b\n"), mimeType: undefined },
      { path: "/w/c.png", bytes: png, mimeType: "image/png" },
    ]);
  });

  it("lists files from resource links", async () => {
    const { client } = fakeClient([{ content: [{ type: "resource_link", name: "a.csv", uri: "file:///w/a.csv", size: 4 }] }]);
    expect(await new AgentCoreSandbox("t", { client }).listFiles(".")).toEqual([{ name: "a.csv", path: "/w/a.csv", size: 4 }]);
  });

  it("throws on a write the service rejects and on stream exceptions", async () => {
    const { client } = fakeClient([{ content: [{ type: "text", text: "path not allowed" }], isError: true }, new Error("Rate exceeded")]);
    const sandbox = new AgentCoreSandbox("t", { client });
    await expect(sandbox.writeFiles([{ path: "/etc/x", text: "" }])).rejects.toThrow("path not allowed");
    await expect(sandbox.executeCode("1")).rejects.toThrow(SandboxError);
  });
});
