import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateSecretCommand, ListSecretsCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNotLinked, FileTokenStore, ItemAlreadyLinkedError, SecretsManagerTokenStore, type StoredItem } from "./tokens";

const item = (over: Partial<StoredItem> = {}): StoredItem => ({
  itemId: "item-1",
  institution: "Tartan Bank",
  institutionId: "ins_109511",
  linkedAt: "2026-10-20T01:03:00.000Z",
  accessToken: "access-sandbox-1",
  ...over,
});

async function rejection(p: Promise<unknown>): Promise<ItemAlreadyLinkedError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ItemAlreadyLinkedError);
  return err as ItemAlreadyLinkedError;
}

describe("assertNotLinked", () => {
  it("refuses a matching institutionId", () => {
    expect(() => assertNotLinked([{ itemId: "a", institutionId: "ins_1" }], "ins_1", "Tartan Bank")).toThrow(
      "Tartan Bank is already linked.",
    );
  });

  it("matches legacy items without an id by name", () => {
    expect(() => assertNotLinked([{ itemId: "a", institution: "Tartan Bank" }], "ins_1", "Tartan Bank")).toThrow(
      "already linked",
    );
  });

  it("allows other institutions", () => {
    expect(() =>
      assertNotLinked([{ itemId: "a", institutionId: "ins_2" }, { itemId: "b", institution: "Other" }], "ins_1", "Tartan Bank"),
    ).not.toThrow();
  });

  it("fails closed on a legacy item with no id or name", () => {
    let err: unknown;
    try {
      assertNotLinked([{ itemId: "a" }], "ins_1", "Tartan Bank");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ reason: "unverified" });
  });

  it("fails closed when the new institution's id is unknown and items exist", () => {
    expect(() => assertNotLinked([{ itemId: "a", institutionId: "ins_2" }], undefined, "Linked institution")).toThrow(
      ItemAlreadyLinkedError,
    );
    expect(() => assertNotLinked([], undefined, "Linked institution")).not.toThrow();
  });
});

describe("FileTokenStore", () => {
  let dir: string;
  let file: string;
  const secret = "x".repeat(32);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "flannel-tokens-"));
    file = path.join(dir, "tokens.json");
  });
  afterEach(() => fs.rm(dir, { recursive: true }));

  it("lists metadata without access tokens", async () => {
    const store = new FileTokenStore(file, secret);
    await store.create(item());
    expect(await store.listInstitutions()).toEqual([{ itemId: "item-1", institution: "Tartan Bank", institutionId: "ins_109511" }]);
  });

  it("refuses a second Item for the same institution and keeps one", async () => {
    const store = new FileTokenStore(file, secret);
    await store.create(item());
    const err = await rejection(store.create(item({ itemId: "item-2", accessToken: "access-sandbox-2" })));
    expect(err.message).toBe("Tartan Bank is already linked.");
    expect(await store.listInstitutions()).toHaveLength(1);
  });

  it("refuses by name against a legacy item stored without institutionId", async () => {
    const store = new FileTokenStore(file, secret);
    await store.create(item({ institutionId: undefined }));
    await rejection(store.create(item({ itemId: "item-2" })));
    expect(await store.listInstitutions()).toHaveLength(1);
  });

  it("links a different institution", async () => {
    const store = new FileTokenStore(file, secret);
    await store.create(item());
    await store.create(item({ itemId: "item-2", institution: "First Platypus Bank", institutionId: "ins_109508" }));
    expect(await store.listInstitutions()).toHaveLength(2);
  });
});

describe("SecretsManagerTokenStore", () => {
  type Secret = { Name: string; Tags?: { Key: string; Value: string }[] };

  // A fake client holding secrets in memory, paging ListSecrets one secret at a time.
  function fakeClient(secrets: Secret[]) {
    const sent: unknown[] = [];
    const client = {
      async send(cmd: unknown) {
        sent.push(cmd);
        if (cmd instanceof ListSecretsCommand) {
          const i = Number(cmd.input.NextToken ?? 0);
          const prefix = cmd.input.Filters?.[0]?.Values?.[0] ?? "";
          const matching = secrets.filter((s) => s.Name.startsWith(prefix));
          return { SecretList: matching.slice(i, i + 1), NextToken: i + 1 < matching.length ? String(i + 1) : undefined };
        }
        if (cmd instanceof CreateSecretCommand) {
          secrets.push({ Name: cmd.input.Name!, Tags: cmd.input.Tags as Secret["Tags"] });
          return {};
        }
        throw new Error("unexpected command");
      },
    };
    return { client: client as unknown as SecretsManagerClient, sent, secrets };
  }

  it("tags new secrets with the institution id and lists them from tags", async () => {
    const fake = fakeClient([{ Name: "other/x" }]);
    const store = new SecretsManagerTokenStore("flannel/plaid/", fake.client);
    await store.create(item());
    expect(fake.secrets.at(-1)).toEqual({
      Name: "flannel/plaid/item-1",
      Tags: [{ Key: "institution-id", Value: "ins_109511" }],
    });
    expect(await store.listInstitutions()).toEqual([{ itemId: "item-1", institutionId: "ins_109511" }]);
  });

  it("refuses a second Item for the same institution across pages", async () => {
    const fake = fakeClient([
      { Name: "flannel/plaid/item-0", Tags: [{ Key: "institution-id", Value: "ins_109508" }] },
      { Name: "flannel/plaid/item-1", Tags: [{ Key: "institution-id", Value: "ins_109511" }] },
    ]);
    const store = new SecretsManagerTokenStore("flannel/plaid/", fake.client);
    await rejection(store.create(item({ itemId: "item-2" })));
    expect(fake.sent.some((c) => c instanceof CreateSecretCommand)).toBe(false);
  });

  it("fails closed on a legacy secret with no institution tag", async () => {
    const fake = fakeClient([{ Name: "flannel/plaid/legacy" }]);
    const store = new SecretsManagerTokenStore("flannel/plaid/", fake.client);
    const err = await rejection(store.create(item({ itemId: "item-2" })));
    expect(err.reason).toBe("unverified");
    expect(fake.secrets).toHaveLength(1);
  });
});
