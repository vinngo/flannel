import { afterEach, describe, expect, it, vi } from "vitest";

// config reads the environment at import, so each case stubs env and re-imports.
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("./config")).config;
}

const CLEAR = {
  INFERENCE_TYPE: undefined,
  PROVIDER: undefined,
  PROVIDER_API_KEY: undefined,
  DIRECT_MODEL_ID: undefined,
  BEDROCK_MODEL_ID: undefined,
  AGENT_EFFORT: undefined,
};

describe("config.inference", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to Claude on Bedrock with medium effort", async () => {
    const { inference } = await load({ ...CLEAR, AGENT_MODE: "strands" });
    expect(inference).toMatchObject({ type: "bedrock", provider: "anthropic", modelId: "anthropic.claude-haiku-5-5", effort: "medium" });
  });

  it("uses DIRECT_MODEL_ID and leaves effort unset in direct mode", async () => {
    const { inference } = await load({
      ...CLEAR,
      AGENT_MODE: "strands",
      INFERENCE_TYPE: "direct",
      PROVIDER_API_KEY: "sk-test",
      DIRECT_MODEL_ID: "gpt-4o",
    });
    expect(inference).toMatchObject({ type: "direct", apiKey: "sk-test", modelId: "gpt-4o", effort: undefined });
  });

  it("requires the key and model ID for a direct strands agent", async () => {
    await expect(load({ ...CLEAR, AGENT_MODE: "strands", INFERENCE_TYPE: "direct", DIRECT_MODEL_ID: "m" })).rejects.toThrow(
      "PROVIDER_API_KEY is required",
    );
    await expect(load({ ...CLEAR, AGENT_MODE: "strands", INFERENCE_TYPE: "direct", PROVIDER_API_KEY: "k" })).rejects.toThrow(
      "DIRECT_MODEL_ID is required",
    );
  });

  it("doesn't require them for the stub agent", async () => {
    await expect(load({ ...CLEAR, AGENT_MODE: "stub", INFERENCE_TYPE: "direct" })).resolves.toBeDefined();
  });
});
