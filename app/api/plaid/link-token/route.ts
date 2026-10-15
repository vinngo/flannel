import { plaidConfigured } from "@/lib/config";
import { getPlaidClient, plaidCountryCodes, plaidErrorMessage, plaidProducts } from "@/lib/plaid";

export async function POST() {
  if (!plaidConfigured()) {
    return Response.json(
      { error: "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in .env.local." },
      { status: 503 },
    );
  }

  try {
    const res = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: "me" },
      client_name: "Flannel",
      products: plaidProducts(),
      country_codes: plaidCountryCodes(),
      language: "en",
    });
    return Response.json({ linkToken: res.data.link_token });
  } catch (err) {
    console.error("linkTokenCreate failed:", plaidErrorMessage(err));
    return Response.json({ error: plaidErrorMessage(err) }, { status: 502 });
  }
}
