import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  CreateSecretCommand,
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

export class ItemAlreadyLinkedError extends Error {
  constructor(itemId: string) {
    super(`Item ${itemId} is already linked`);
  }
}

/**
 * The web app only ever creates tokens. It has no read path, matching the
 * spec's split: only the MCP server can read access tokens.
 */
export interface TokenStore {
  create(item: StoredItem): Promise<void>;
}

// --- Secrets Manager: one secret per Item, create-only ----------------------

export class SecretsManagerTokenStore implements TokenStore {
  private client = new SecretsManagerClient({});

  constructor(private prefix = config.tokens.secretPrefix) {}

  async create(item: StoredItem): Promise<void> {
    try {
      await this.client.send(
        new CreateSecretCommand({ Name: `${this.prefix}${item.itemId}`, SecretString: JSON.stringify(item) }),
      );
    } catch (err) {
      if (err instanceof ResourceExistsException) throw new ItemAlreadyLinkedError(item.itemId);
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

  async create(item: StoredItem): Promise<void> {
    const store = await this.read();
    if (store.items.some((i) => i.itemId === item.itemId)) throw new ItemAlreadyLinkedError(item.itemId);

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
