import type { NextRequest } from "next/server";
import { getArtifactStore, InvalidArtifactKeyError } from "@/lib/artifacts";

/** Returns a browser-openable URL for a session artifact (presigned in S3 mode). */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  try {
    return Response.json({ url: await getArtifactStore().urlFor(key) });
  } catch (err) {
    if (err instanceof InvalidArtifactKeyError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
