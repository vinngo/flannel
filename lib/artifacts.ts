import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config";

/**
 * Session artifacts (reports, charts, derived CSVs) under `sessions/<id>/`.
 * The web app may only see that prefix; snapshots and latest.json stay private.
 */
export class InvalidArtifactKeyError extends Error {}

export function assertArtifactKey(key: string): string {
  const parts = key.split("/");
  if (parts[0] !== "sessions" || parts.length < 3 || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new InvalidArtifactKeyError(`Not a session artifact key: ${key}`);
  }
  return key;
}

const PRESIGN_SECONDS = 300;

export interface ArtifactStore {
  /** URL the browser can open for this key. */
  urlFor(key: string): Promise<string>;
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
}

export class LocalArtifactStore implements ArtifactStore {
  private root: string;

  constructor(dir = config.artifacts.localDir) {
    this.root = path.resolve(dir);
  }

  resolve(key: string): string {
    const full = path.resolve(this.root, assertArtifactKey(key));
    if (!full.startsWith(this.root + path.sep)) throw new InvalidArtifactKeyError(`Key escapes store root: ${key}`);
    return full;
  }

  async urlFor(key: string): Promise<string> {
    assertArtifactKey(key);
    return `/api/artifacts/local?key=${encodeURIComponent(key)}`;
  }

  async put(key: string, body: string | Uint8Array): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}

export class S3ArtifactStore implements ArtifactStore {
  private client = new S3Client({});

  constructor(private bucket = config.artifacts.bucket) {
    if (!bucket) throw new Error("SNAPSHOT_BUCKET must be set when ARTIFACT_STORE=s3.");
  }

  async urlFor(key: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: assertArtifactKey(key) });
    return getSignedUrl(this.client, cmd, { expiresIn: PRESIGN_SECONDS });
  }

  async put(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: assertArtifactKey(key), Body: body, ContentType: contentType }),
    );
  }
}

let artifactStore: ArtifactStore | null = null;

export function getArtifactStore(): ArtifactStore {
  if (!artifactStore) {
    artifactStore = config.artifacts.kind === "s3" ? new S3ArtifactStore() : new LocalArtifactStore();
  }
  return artifactStore;
}

const CONTENT_TYPES: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".html": "text/plain; charset=utf-8", // never render agent-written HTML on our origin
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
}
