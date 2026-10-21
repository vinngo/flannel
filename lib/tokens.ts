import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  CreateSecretCommand,
  ListSecretsCommand,
  ResourceExistsException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { config } from "./config";

/** One linked Plaid Item. Same shape as plaid-agent-mcp's StoredItem. */
export interface StoredItem {
  itemId: string;
  institution: string;
  institutionId?: string;
  linkedAt: string;
  accessToken: string;
}

/** A linked Item without its access token. `institution` is unknown for untagged secrets. */
export type LinkedInstitution = Omit<StoredItem, "accessToken" | "linkedAt" | "institution"> & {
  institution?: string;
};

export class ItemAlreadyLinkedError extends Error {
  constructor(
    message: string,
    /** "unverified": items with no recorded institution mean a duplicate can't be ruled out. */
    readonly reason: "linked" | "unverified" = "linked",
  ) {
    super(message);
  }
}

/**
 * The web app creates tokens and lists Item metadata, but has no read path for
 * access tokens, matching the spec's split: only the MCP server can read them.
 */
export interface TokenStore {
  /** Throws ItemAlreadyLinkedError if the Item or its institution is already linked. */
  create(item: StoredItem): Promise<void>;
  listInstitutions(): Promise<LinkedInstitution[]>;
}

/**
 * Throws if linking this institution would duplicate an Item. Mirrors
 * plaid-agent-mcp's checkExistingItem: matches on institutionId, falls back to
 * the name for legacy items stored without an id, and fails closed when a
 * legacy item has no name either (or the new institution's id is unknown).
 */
export function assertNotLinked(
  items: LinkedInstitution[],
  institutionId: string | undefined,
  institutionName: string,
): void {
  const linked =
    (institutionId && items.find((i) => i.institutionId === institutionId)) ||
    items.find((i) => !i.institutionId && i.institution === institutionName);
  if (linked) throw new ItemAlreadyLinkedError(`${institutionName} is already linked.`);

  const unverifiable = institutionId ? items.some((i) => !i.institutionId && !i.institution) : items.length > 0;
  if (unverifiable) {
    throw new ItemAlreadyLinkedError(`Couldn't confirm ${institutionName} isn't already linked.`, "unverified");
  }
}

// --- Secrets Manager: one secret per Item, create-only ----------------------
//
// The institution id is also written as a tag so listInstitutions can read it
// with ListSecrets alone, without GetSecretValue. Secrets created elsewhere
// (e.g. plaid-agent-mcp's sandbox-link) carry no tag and so fail closed.

const INSTITUTION_ID_TAG = "institution-id";

export class SecretsManagerTokenStore implements TokenStore {
  constructor(
    private prefix = config.tokens.secretPrefix,
    private client: SecretsManagerClient = new SecretsManagerClient({}),
  ) {}

  async listInstitutions(): Promise<LinkedInstitution[]> {
    const items: LinkedInstitution[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListSecretsCommand({ Filters: [{ Key: "name", Values: [this.prefix] }], NextToken: nextToken }),
      );
      for (const s of page.SecretList ?? []) {
        if (!s.Name?.startsWith(this.prefix)) continue;
        items.push({
          itemId: s.Name.slice(this.prefix.length),
          institutionId: s.Tags?.find((t) => t.Key === INSTITUTION_ID_TAG)?.Value,
        });
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return items;
  }

  async create(item: StoredItem): Promise<void> {
    // Not atomic: two concurrent links can both pass this check. The caller
    // removes the new Item at Plaid when create throws, which covers the
    // common case; the residual race needs a lock this store doesn't have.
    assertNotLinked(await this.listInstitutions(), item.institutionId, item.institution);
    try {
      await this.client.send(
        new CreateSecretCommand({
          Name: `${this.prefix}${item.itemId}`,
          SecretString: JSON.stringify(item),
          Tags: item.institutionId ? [{ Key: INSTITUTION_ID_TAG, Value: item.institutionId }] : undefined,
        }),
      );
    } catch (err) {
      if (err instanceof ResourceExistsException) {
        throw new ItemAlreadyLinkedError(`${item.institution} is already linked.`);
      }
      throw err;
    }
  }
}

// --- Local encrypted file (development only) -------------------------------
//
// Byte-compatible with plaid-agent-mcp/src/storage/tokens.ts FileTokenStore:
// same file shape, cipher, scrypt salt and file modes.

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

interface FileShape {
  version: 1;
  items: (Omit<StoredItem, "accessToken"> & { accessToken: EncryptedBlob })[];
}

export class FileTokenStore implements TokenStore {
  private file: string;

  constructor(filePath = config.tokens.filePath, private secret = config.tokens.encryptionKey) {
    this.file = path.resolve(filePath);
  }

  private key(): Buffer {
    if (!this.secret) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be set (32+ chars) to use the local token store.");
    }
    return crypto.scryptSync(this.secret, "plaid-agent-token-store", 32);
  }

  private async read(): Promise<FileShape> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as FileShape;
      return parsed.items ? parsed : { version: 1, items: [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [] };
      throw err;
    }
  }

  async listInstitutions(): Promise<LinkedInstitution[]> {
    const { items } = await this.read();
    return items.map(({ itemId, institution, institutionId }) => ({ itemId, institution, institutionId }));
  }

  async create(item: StoredItem): Promise<void> {
    const store = await this.read();
    if (store.items.some((i) => i.itemId === item.itemId)) {
      throw new ItemAlreadyLinkedError(`${item.institution} is already linked.`);
    }
    assertNotLinked(store.items, item.institutionId, item.institution);

    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([c.update(item.accessToken, "utf8"), c.final()]);
    store.items.push({
      itemId: item.itemId,
      institution: item.institution,
      institutionId: item.institutionId,
      linkedAt: item.linkedAt,
      accessToken: { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") },
    });
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(store, null, 2), { mode: 0o600 });
  }
}

let tokenStore: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!tokenStore) {
    tokenStore = config.tokens.kind === "secrets-manager" ? new SecretsManagerTokenStore() : new FileTokenStore();
  }
  return tokenStore;
}
