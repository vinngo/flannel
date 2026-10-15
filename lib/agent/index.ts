import "server-only";
import { config } from "../config";
import { StubAgent } from "./stub";
import type { Agent } from "./types";

let agent: Agent | null = null;

/** The Strands agent on AgentCore Runtime slots in here behind AGENT_MODE. */
export function getAgent(): Agent {
  if (!agent) {
    switch (config.agentMode) {
      case "stub":
        agent = new StubAgent();
        break;
    }
  }
  return agent;
}
