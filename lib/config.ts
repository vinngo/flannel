import "server-only";

// Env names match plaid-agent-mcp/src/config.ts so one .env shape covers both.

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined ? fallback : v.trim();
}

function list(name: string, fallback: string[]): string[] {
  const v = str(name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (got "${v}")`);
  return n;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name).toLowerCase();
  if (!v) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`${name} must be one of: ${allowed.join(", ")} (got "${v}")`);
}

export const config = {
  agentMode: oneOf("AGENT_MODE", ["stub", "strands"] as const, "stub"),
  bedrock: {
    region: str("AWS_REGION", "us-west-2"),
    modelId: str("BEDROCK_MODEL_ID", "anthropic.claude-haiku-5-5"),
    effort: oneOf("AGENT_EFFORT", ["low", "medium", "high"] as const, "medium"),
    provider: oneOf("PROVIDER", ["anthropic", "openai"] as const, "anthropic"),
  },
  codeInterpreter: {
    region: str("AWS_REGION", "us-west-2"),
    // The AWS-managed interpreter: no network access, pandas and matplotlib preinstalled.
    identifier: str("CODE_INTERPRETER_ID", "aws.codeinterpreter.v1"),
    // Hard cap on a session's life, so a run that never closes its session can't bill for hours.
    timeoutSeconds: int("CODE_INTERPRETER_TIMEOUT_SECONDS", 900),
  },
  mcp: {
    url: str("MCP_URL", "http://127.0.0.1:3000/mcp"),
    apiKey: str("MCP_API_KEY"),
  },
  plaid: {
    clientId: str("PLAID_CLIENT_ID"),
    secret: str("PLAID_SECRET"),
    env: oneOf("PLAID_ENV", ["sandbox", "production"] as const, "sandbox"),
    products: list("PLAID_PRODUCTS", ["investments"]),
    countryCodes: list("PLAID_COUNTRY_CODES", ["US"]),
  },
  tokens: {
    kind: oneOf("TOKEN_STORE", ["file", "secrets-manager"] as const, "file"),
    // Shared with the local MCP server so a link made here is visible there.
    filePath: str("TOKEN_STORE_PATH", "../plaid-agent-mcp/data/items.json"),
    encryptionKey: str("TOKEN_ENCRYPTION_KEY"),
    secretPrefix: str("PLAID_TOKEN_SECRET_PREFIX", "plaid-agent/items/"),
  },
  artifacts: {
    kind: oneOf("ARTIFACT_STORE", ["local", "s3"] as const, "local"),
    localDir: str("ARTIFACT_DIR", "../plaid-agent-mcp/data/store"),
    bucket: str("SNAPSHOT_BUCKET"),
  },
};

export function plaidConfigured(): boolean {
  return Boolean(config.plaid.clientId && config.plaid.secret);
}
