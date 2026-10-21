import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedInstitution, StoredItem, TokenStore } from "@/lib/tokens";

const plaid = {
  itemPublicTokenExchange: vi.fn(),
  itemGet: vi.fn(),
  itemRemove: vi.fn(),
};
let store: ReturnType<typeof memoryStore>;

vi.mock("@/lib/config", () => ({ plaidConfigured: () => true }));
vi.mock("@/lib/plaid", () => ({ getPlaidClient: () => plaid, plaidErrorMessage: (e: Error) => e.message }));
vi.mock("@/lib/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tokens")>()),
  getTokenStore: () => store,
}));

const { POST } = await import("./route");
const { assertNotLinked } = await import("@/lib/tokens");

// In-memory store with the same institution check as the real stores.
function memoryStore(items: LinkedInstitution[] = []): TokenStore & { items: LinkedInstitution[] } {
  return {
    items,
    async listInstitutions() {
      return items;
    },
    async create(item: StoredItem) {
      assertNotLinked(items, item.institutionId, item.institution);
      items.push({ itemId: item.itemId, institution: item.institution, institutionId: item.institutionId });
    },
  };
}

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/plaid/exchange", { method: "POST", body: JSON.stringify(body) }));

const tartan = { name: "Tartan Bank", id: "ins_109511" };

beforeEach(() => {
  vi.resetAllMocks();
  plaid.itemPublicTokenExchange.mockResolvedValue({ data: { item_id: "item-new", access_token: "access-new" } });
  plaid.itemRemove.mockResolvedValue({});
});

describe("POST /api/plaid/exchange", () => {
  it("stores a new institution", async () => {
    store = memoryStore();
    const res = await post({ publicToken: "public-1", institution: tartan });
    expect(res.status).toBe(200);
    expect(store.items).toEqual([{ itemId: "item-new", institution: "Tartan Bank", institutionId: "ins_109511" }]);
  });

  it("refuses an already-linked institution without exchanging the token", async () => {
    store = memoryStore([{ itemId: "item-old", institution: "Tartan Bank", institutionId: "ins_109511" }]);
    const res = await post({ publicToken: "public-1", institution: tartan });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Tartan Bank is already linked." });
    expect(plaid.itemPublicTokenExchange).not.toHaveBeenCalled();
    expect(store.items).toHaveLength(1);
  });

  it("removes the new Item at Plaid when a duplicate gets past the pre-check", async () => {
    const s = memoryStore();
    // Another Link session stores the same institution between the check and create.
    s.listInstitutions = async () => [];
    s.items.push({ itemId: "item-race", institutionId: "ins_109511" });
    store = s;
    const res = await post({ publicToken: "public-1", institution: tartan });
    expect(res.status).toBe(409);
    expect(plaid.itemRemove).toHaveBeenCalledWith({ access_token: "access-new" });
    expect(s.items).toHaveLength(1);
  });

  it("looks up the institution id when Link sends none, and refuses a duplicate", async () => {
    store = memoryStore([{ itemId: "item-old", institutionId: "ins_109511" }]);
    plaid.itemGet.mockResolvedValue({ data: { item: { institution_id: "ins_109511" } } });
    const res = await post({ publicToken: "public-1", institution: null });
    expect(res.status).toBe(409);
    expect(plaid.itemRemove).toHaveBeenCalledWith({ access_token: "access-new" });
  });
});
