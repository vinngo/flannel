import type { ToolList } from "@strands-agents/sdk";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../artifacts";
import type { ExecResult, Sandbox, SandboxEntry, SandboxFile } from "../sandbox";
import type { SnapshotReader } from "../snapshots";
import { artifactName, sandboxTools } from "./sandbox-tools";

/** An in-memory sandbox: files are a map, and code runs through a scripted handler. */
class FakeSandbox implements Sandbox {
  files = new Map<string, Uint8Array>();
  ran: string[] = [];
  constructor(private exec: (code: string) => ExecResult = () => ({ stdout: "", stderr: "", isError: false })) {}
  async executeCode(code: string) {
    this.ran.push(code);
    return this.exec(code);
  }
  async writeFiles(files: { path: string; text: string }[]) {
    for (const f of files) this.files.set(f.path, new TextEncoder().encode(f.text));
  }
  async readFiles(paths: string[]): Promise<SandboxFile[]> {
    return paths.flatMap((p) => (this.files.has(p) ? [{ path: p, bytes: this.files.get(p)! }] : []));
  }
  async listFiles(): Promise<SandboxEntry[]> {
    return [...this.files.keys()].map((p) => ({ name: p.split("/").pop()!, path: p }));
  }
  async close() {}
}

class MemoryArtifacts implements ArtifactStore {
  puts: { key: string; body: string | Uint8Array; contentType: string }[] = [];
  async urlFor(key: string) {
    return key;
  }
  async put(key: string, body: string | Uint8Array, contentType: string) {
    this.puts.push({ key, body, contentType });
  }
}

const HOLDINGS_KEY = "snapshots/2026-10-19T2146/holdings.csv";
const HOLDINGS = "ticker,market_value\nVTI,12496\nFXAIX,12232.25\n";

function setup(exec?: (code: string) => ExecResult) {
  const sandbox = new FakeSandbox(exec);
  const artifacts = new MemoryArtifacts();
  const snapshots: SnapshotReader = { read: async (key) => (key === HOLDINGS_KEY ? HOLDINGS : null) };
  const tools = sandboxTools({ sandbox, snapshots, artifacts, sessionId: "s1" });
  return { sandbox, artifacts, call: (name: string, input: unknown) => invoke(tools, name, input) };
}

/** Runs one tool's callback the way the agent loop would and returns its JSON result. */
async function invoke(tools: ToolList, name: string, input: unknown): Promise<Record<string, unknown>> {
  const t = tools.find((x) => "name" in x && x.name === name) as unknown as {
    invoke(input: unknown): Promise<unknown>;
  };
  if (!t) throw new Error(`no tool ${name}`);
  return JSON.parse((await t.invoke(input)) as string);
}

describe("sandboxTools", () => {
  it("exposes the spec's tool names", () => {
    const { sandbox, artifacts } = setup();
    const tools = sandboxTools({ sandbox, artifacts, snapshots: { read: async () => null }, sessionId: "s1" });
    expect(tools.map((t) => ("name" in t ? t.name : "?"))).toEqual([
      "load_snapshot",
      "execute_code",
      "write_files",
      "read_files",
      "list_files",
      "file_artifact",
    ]);
  });

  it("load_snapshot copies the file to the same path in the sandbox", async () => {
    const { sandbox, call } = setup();
    const result = await call("load_snapshot", { s3_key: HOLDINGS_KEY });
    expect(result).toMatchObject({ path: HOLDINGS_KEY, summary: `2 rows → ${HOLDINGS_KEY}` });
    expect(new TextDecoder().decode(sandbox.files.get(HOLDINGS_KEY))).toBe(HOLDINGS);
  });

  it("load_snapshot fails on a missing key", async () => {
    const { call } = setup();
    await expect(call("load_snapshot", { s3_key: "snapshots/x/holdings.csv" })).rejects.toThrow(/No snapshot file/);
  });

  it("execute_code returns stdout and throws on a Python error", async () => {
    const { call } = setup((code) =>
      code.includes("boom")
        ? { stdout: "", stderr: "NameError: boom", exitCode: 1, isError: true }
        : { stdout: "total 24728.25\nrows 2\n", stderr: "", exitCode: 0, isError: false },
    );
    expect(await call("execute_code", { code: "print(df.market_value.sum())" })).toEqual({
      stdout: "total 24728.25\nrows 2\n",
      summary: "ran Python, 2 lines of output",
    });
    await expect(call("execute_code", { code: "boom" })).rejects.toThrow("NameError: boom");
  });

  it("execute_code clips long output", async () => {
    const { call } = setup(() => ({ stdout: "x".repeat(30_000), stderr: "", isError: false }));
    const { stdout } = await call("execute_code", { code: "print('x' * 30000)" });
    expect((stdout as string).length).toBeLessThan(21_000);
    expect(stdout).toMatch(/10000 more characters cut/);
  });

  it("file_artifact copies the sandbox file under the session prefix", async () => {
    const { sandbox, artifacts, call } = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    sandbox.files.set("out/allocation chart.png", png);

    const result = await call("file_artifact", { path: "out/allocation chart.png" });
    const key = "sessions/s1/allocation_chart.png";
    expect(result).toEqual({
      s3_key: key,
      summary: key,
      artifact: { key, name: "allocation_chart.png", content_type: "image/png" },
    });
    expect(artifacts.puts).toEqual([{ key, body: png, contentType: "image/png" }]);
  });

  it("file_artifact fails when the file isn't there", async () => {
    const { call } = setup();
    await expect(call("file_artifact", { path: "nope.csv" })).rejects.toThrow(/No file at nope.csv/);
  });
});

describe("artifactName", () => {
  it("keeps the basename and replaces unsafe characters", () => {
    expect(artifactName("/tmp/out/report.md")).toBe("report.md");
    expect(artifactName("weights (v2).csv")).toBe("weights__v2_.csv");
  });

  it("rejects paths with no usable filename", () => {
    expect(() => artifactName("..")).toThrow();
    expect(() => artifactName("/")).toThrow();
  });
});
