import { z } from "zod";
import { plaidConfigured } from "@/lib/config";
import { getPlaidClient, plaidErrorMessage } from "@/lib/plaid";
import { getTokenStore, ItemAlreadyLinkedError } from "@/lib/tokens";

const Body = z.object({
  publicToken: z.string().min(1),
  institution: z.object({ name: z.string(), id: z.string() }).nullish(),
});

export async function POST(req: Request) {
  if (!plaidConfigured()) {
    return Response.json({ error: "Plaid is not configured." }, { status: 503 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Body must be {publicToken, institution?}" }, { status: 400 });
  }
  const { publicToken, institution } = parsed.data;

  let exchange;
  try {
    exchange = await getPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
  } catch (err) {
    console.error("itemPublicTokenExchange failed:", plaidErrorMessage(err));
    return Response.json({ error: plaidErrorMessage(err) }, { status: 502 });
  }

  const { item_id: itemId, access_token: accessToken } = exchange.data;
  const institutionName = institution?.name || "Linked institution";
  try {
    await getTokenStore().create({
      itemId,
      institution: institutionName,
      institutionId: institution?.id,
      linkedAt: new Date().toISOString(),
      accessToken,
    });
  } catch (err) {
    if (err instanceof ItemAlreadyLinkedError) {
      return Response.json({ error: `${institutionName} is already linked.` }, { status: 409 });
    }
    console.error("Storing the access token failed:", (err as Error).message);
    return Response.json({ error: "Could not store the linked account." }, { status: 500 });
  }

  // The access token never leaves the server.
  return Response.json({ itemId, institution: institutionName });
}
