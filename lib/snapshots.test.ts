import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSnapshotKey, LocalSnapshotReader } from "./snapshots";

describe("assertSnapshotKey", () => {
  it("accepts snapshots/<ts>/<file>", () => {
    expect(assertSnapshotKey("snapshots/2026-10-19T2146/holdings.csv")).toBe("snapshots/2026-10-19T2146/holdings.csv");
  });

  it.each(["latest.json", "sessions/a/b.csv", "snapshots/../latest.json", "snapshots/x/../../y", "snapshots//a.csv"])(
    "rejects %s",
    (key) => expect(() => assertSnapshotKey(key)).toThrow(),
  );
});

describe("LocalSnapshotReader", () => {
  it("reads a snapshot file and returns null when it is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "flannel-snap-"));
    await fs.mkdir(path.join(root, "snapshots/t1"), { recursive: true });
    await fs.writeFile(path.join(root, "snapshots/t1/holdings.csv"), "a,b\n");
    const reader = new LocalSnapshotReader(root);

    expect(await reader.read("snapshots/t1/holdings.csv")).toBe("a,b\n");
    expect(await reader.read("snapshots/t1/transactions.csv")).toBeNull();
    await fs.rm(root, { recursive: true });
  });
});
