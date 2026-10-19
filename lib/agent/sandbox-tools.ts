import "server-only";
import path from "node:path";
import { tool, type ToolList } from "@strands-agents/sdk";
import { z } from "zod";
import { contentTypeFor, type ArtifactStore } from "../artifacts";
import type { Sandbox } from "../sandbox";
import type { SnapshotReader } from "../snapshots";

// The spec's sandbox tools: load_snapshot and file_artifact move files between
// the store and the Code Interpreter; the rest run analysis inside it. Results
// are JSON text with a `summary`, like the MCP tools, so the UI reads them the same way.

/** Keeps a chatty print() from flooding the model's context. */
const MAX_OUTPUT_CHARS = 20_000;
/** Text files the agent may read back whole; anything bigger stays in the sandbox. */
const MAX_READ_CHARS = 50_000;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters cut)` : s;
}

/** A filename safe to use as the last segment of `sessions/<id>/<name>`. */
export function artifactName(sandboxPath: string): string {
  const name = path.posix.basename(sandboxPath).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!name || /^\.+$/.test(name)) throw new Error(`Can't file "${sandboxPath}": it has no usable filename.`);
  return name;
}

export interface SandboxToolDeps {
  sandbox: Sandbox;
  snapshots: SnapshotReader;
  artifacts: ArtifactStore;
  sessionId: string;
}

export function sandboxTools({ sandbox, snapshots, artifacts, sessionId }: SandboxToolDeps): ToolList {
  return [
    tool({
      name: "load_snapshot",
      description:
        "Copy a snapshot file (an s3_key returned by pull_holdings, pull_transactions or snapshot_status) into the " +
        "sandbox. Returns the sandbox path to open with pandas.",
      inputSchema: z.object({ s3_key: z.string().describe("Key like snapshots/2026-10-19T2146/holdings.csv") }),
      callback: async ({ s3_key }) => {
        const body = await snapshots.read(s3_key);
        if (body === null) throw new Error(`No snapshot file at ${s3_key}. Call snapshot_status for current keys.`);
        // Same relative path in the sandbox, so files from two pulls never collide.
        const target = s3_key;
        await sandbox.writeFiles([{ path: target, text: body }]);
        const rows = Math.max(0, body.trimEnd().split("\n").length - 1);
        const summary = s3_key.endsWith(".csv") ? `${rows} rows → ${target}` : `copied to ${target}`;
        return JSON.stringify({ path: target, bytes: Buffer.byteLength(body), summary });
      },
    }),
    tool({
      name: "execute_code",
      description:
        "Run Python in the sandbox. State persists between calls within this answer. pandas and matplotlib are " +
        "installed; there is no network access. Print every figure you will report.",
      inputSchema: z.object({ code: z.string().describe("Python source") }),
      callback: async ({ code }) => {
        const r = await sandbox.executeCode(code);
        const stdout = clip(r.stdout, MAX_OUTPUT_CHARS);
        const stderr = clip(r.stderr, MAX_OUTPUT_CHARS);
        if (r.isError) throw new Error(stderr || stdout || `Python exited with code ${r.exitCode ?? "unknown"}.`);
        const lines = stdout.trimEnd() ? stdout.trimEnd().split("\n").length : 0;
        return JSON.stringify({ stdout, stderr: stderr || undefined, summary: `ran Python, ${lines} lines of output` });
      },
    }),
    tool({
      name: "write_files",
      description: "Write text files into the sandbox, such as a helper script or a CSV you built.",
      inputSchema: z.object({
        files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
      }),
      callback: async ({ files }) => {
        await sandbox.writeFiles(files.map((f) => ({ path: f.path, text: f.content })));
        return JSON.stringify({ written: files.map((f) => f.path), summary: `wrote ${files.length} file(s)` });
      },
    }),
    tool({
      name: "read_files",
      description: "Read small text files back from the sandbox. Use execute_code to inspect large or binary files.",
      inputSchema: z.object({ paths: z.array(z.string()).min(1) }),
      callback: async ({ paths }) => {
        const files = await sandbox.readFiles(paths);
        const decoder = new TextDecoder();
        return JSON.stringify({
          files: files.map((f) => ({ path: f.path, content: clip(decoder.decode(f.bytes), MAX_READ_CHARS) })),
          summary: `read ${files.length} file(s)`,
        });
      },
    }),
    tool({
      name: "list_files",
      description: "List a sandbox directory.",
      inputSchema: z.object({ path: z.string().default(".") }),
      callback: async ({ path: dir }) => {
        const entries = await sandbox.listFiles(dir);
        return JSON.stringify({ entries, summary: `${entries.length} entries in ${dir}` });
      },
    }),
    tool({
      name: "file_artifact",
      description:
        "Save a sandbox file (CSV, PNG chart, Markdown report) for the user. It appears under your answer. " +
        "File only what the user would want to keep.",
      inputSchema: z.object({ path: z.string().describe("Sandbox path of the file") }),
      callback: async ({ path: sandboxPath }) => {
        const name = artifactName(sandboxPath);
        const [file] = await sandbox.readFiles([sandboxPath]);
        if (!file) throw new Error(`No file at ${sandboxPath} in the sandbox.`);
        const key = `sessions/${sessionId}/${name}`;
        const contentType = contentTypeFor(name);
        await artifacts.put(key, file.bytes, contentType);
        return JSON.stringify({ s3_key: key, summary: key, artifact: { key, name, content_type: contentType } });
      },
    }),
  ];
}
