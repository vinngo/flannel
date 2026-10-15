import "server-only";
import { config } from "../config";
import { StrandsAgent } from "./strands";
import { StubAgent } from "./stub";
import type { Agent } from "./types";

let agent: Agent | null = null;

/** stub: canned answers. strands: Claude on Bedrock over the local MCP tools. */
export function getAgent(): Agent {
  if (!agent) {
    switch (config.agentMode) {
      case "stub":
        agent = new StubAgent();
        break;
      case "strands":
        agent = new StrandsAgent();
        break;
    }
  }
  return agent;
}
