import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { contentTypeFor, InvalidArtifactKeyError, LocalArtifactStore } from "@/lib/artifacts";

/** Local-dev stand-in for a presigned S3 URL. */
export async function GET(req: NextRequest) {
  if (config.artifacts.kind !== "local") return new Response("Not found", { status: 404 });

  const key = req.nextUrl.searchParams.get("key") ?? "";
  let body: Buffer | null;
  try {
    body = await new LocalArtifactStore().read(key);
  } catch (err) {
    if (err instanceof InvalidArtifactKeyError) return new Response(err.message, { status: 400 });
    throw err;
  }
  if (!body) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": contentTypeFor(key),
      "Content-Disposition": `inline; filename="${key.split("/").pop()}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
