import type { TKey } from "./i18n/shared";
import { normalizeHashPath } from "./hash-routing";

/** One entry per agent: navigation and setup copy grow together. */
export const AGENT_CATALOG = [
  {
    id: "claude-code", name: "Claude Code", description: "agents.claude.description",
    steps: ["agents.claude.install", "agents.claude.enable", "agents.claude.desktop"],
    guide: "https://code.claude.com/docs/en/quickstart",
  },
  {
    id: "codex", name: "Codex", description: "agents.codex.description",
    steps: ["agents.codex.install", "agents.codex.pair", "agents.codex.start"],
    guide: "https://developers.openai.com/codex/app/",
  },
] as const satisfies readonly {
  id: string; name: string; description: TKey; steps: readonly TKey[]; guide: string;
}[];

export type AgentId = (typeof AGENT_CATALOG)[number]["id"];
export const AGENT_HASHES = AGENT_CATALOG.map(agent => `agents/${agent.id}`);
export function readAgentTab(hash: string): AgentId {
  return AGENT_CATALOG.find(agent => `agents/${agent.id}` === normalizeHashPath(hash))?.id ?? AGENT_CATALOG[0].id;
}
