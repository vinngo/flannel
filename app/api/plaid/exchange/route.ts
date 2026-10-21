import { z } from "zod";
import { plaidConfigured } from "@/lib/config";
import { getPlaidClient, plaidErrorMessage } from "@/lib/plaid";
import { assertNotLinked, getTokenStore, ItemAlreadyLinkedError } from "@/lib/tokens";

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
  const store = getTokenStore();
  const plaid = getPlaidClient();

  // Refuse a duplicate before exchanging, so no Item is created at Plaid.
  if (institution) {
    try {
      assertNotLinked(await store.listInstitutions(), institution.id, institution.name);
    } catch (err) {
      return storeError(err);
    }
  }

  let exchange;
  try {
    exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  } catch (err) {
    console.error("itemPublicTokenExchange failed:", plaidErrorMessage(err));
    return Response.json({ error: plaidErrorMessage(err) }, { status: 502 });
  }

  const { item_id: itemId, access_token: accessToken } = exchange.data;
  let institutionId = institution?.id;
  if (!institutionId) {
    // Link sent no institution, so the pre-check was skipped; ask Plaid so
    // create() can still match on the id.
    try {
      institutionId = (await plaid.itemGet({ access_token: accessToken })).data.item.institution_id ?? undefined;
    } catch (err) {
      console.error("itemGet failed:", plaidErrorMessage(err));
    }
  }
  const institutionName = institution?.name || "Linked institution";
  try {
    await store.create({ itemId, institution: institutionName, institutionId, linkedAt: new Date().toISOString(), accessToken });
  } catch (err) {
    // The Item exists at Plaid but won't be stored; remove it so it isn't left active.
    try {
      await plaid.itemRemove({ access_token: accessToken });
    } catch (removeErr) {
      console.error(`itemRemove failed for unstored Item ${itemId}:`, plaidErrorMessage(removeErr));
    }
    return storeError(err);
  }

  // The access token never leaves the server.
  return Response.json({ itemId, institution: institutionName });
}

function storeError(err: unknown): Response {
  if (err instanceof ItemAlreadyLinkedError) return Response.json({ error: err.message }, { status: 409 });
  console.error("Token store failed:", (err as Error).message);
  return Response.json({ error: "Could not store the linked account." }, { status: 500 });
}
