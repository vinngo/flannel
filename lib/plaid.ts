import "server-only";
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from "plaid";
import { config } from "./config";

let client: PlaidApi | null = null;

export function getPlaidClient(): PlaidApi {
  if (!client) {
    client = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[config.plaid.env],
        baseOptions: {
          headers: {
            "PLAID-CLIENT-ID": config.plaid.clientId,
            "PLAID-SECRET": config.plaid.secret,
          },
        },
      }),
    );
  }
  return client;
}

export const plaidProducts = () => config.plaid.products as Products[];
export const plaidCountryCodes = () => config.plaid.countryCodes as CountryCode[];

/** Plaid errors carry their detail on the axios response; never include tokens. */
export function plaidErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { error_message?: string; error_code?: string } } }).response?.data;
  if (data?.error_message) return data.error_code ? `${data.error_message} (${data.error_code})` : data.error_message;
  return (err as Error).message ?? "Plaid request failed";
}
