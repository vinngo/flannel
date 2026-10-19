import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config";

/**
 * Read access to the MCP server's snapshots (`snapshots/<ts>/<file>`), for the
 * agent only. Shares the store root with session artifacts; the web app never
 * serves these keys.
 */
export class InvalidSnapshotKeyError extends Error {}

export function assertSnapshotKey(key: string): string {
  const parts = key.split("/");
  if (parts[0] !== "snapshots" || parts.length !== 3 || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new InvalidSnapshotKeyError(`Not a snapshot key: ${key}`);
  }
  return key;
}

export interface SnapshotReader {
  /** The file's text, or null when the key doesn't exist. */
  read(key: string): Promise<string | null>;
}

export class LocalSnapshotReader implements SnapshotReader {
  private root: string;

  constructor(dir = config.artifacts.localDir) {
    this.root = path.resolve(dir);
  }

  async read(key: string): Promise<string | null> {
    const full = path.resolve(this.root, assertSnapshotKey(key));
    if (!full.startsWith(this.root + path.sep)) throw new InvalidSnapshotKeyError(`Key escapes store root: ${key}`);
    try {
      return await fs.readFile(full, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}

export class S3SnapshotReader implements SnapshotReader {
  private client = new S3Client({});

  constructor(private bucket = config.artifacts.bucket) {
    if (!bucket) throw new Error("SNAPSHOT_BUCKET must be set when ARTIFACT_STORE=s3.");
  }

  async read(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: assertSnapshotKey(key) }));
      return (await res.Body?.transformToString("utf-8")) ?? null;
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }
}

let reader: SnapshotReader | null = null;

export function getSnapshotReader(): SnapshotReader {
  reader ??= config.artifacts.kind === "s3" ? new S3SnapshotReader() : new LocalSnapshotReader();
  return reader;
}
