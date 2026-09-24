import { opencodeAdapter } from "./opencode.js";
import type { AgentAdapter } from "./types.js";

/** Every adapter ships here, in display order: adding one is an import plus a line. */
const registered: AgentAdapter[] = [opencodeAdapter];

export const AGENTS: readonly AgentAdapter[] = registered;

/** Append an adapter at runtime (test fixtures). Idempotent by id. */
export function registerAgent(adapter: AgentAdapter): void {
  if (registered.some((entry) => entry.id === adapter.id)) return;
  registered.push(adapter);
}

/** Resolve an agent id or alias to its adapter. */
export function findAgent(name: string): AgentAdapter | undefined {
  return AGENTS.find(
    (adapter) => adapter.id === name || adapter.aliases?.some((alias) => alias === name),
  );
}
