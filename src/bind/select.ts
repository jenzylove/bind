// AI agent selection — the "smart routing" layer. Instead of keyword scoring, we hand
// Claude the user's goal and the whole discovered marketplace (name, category, what each
// agent does, its cheapest fee, and whether it's tested-payable) and let it pick the few
// agents that genuinely fit the goal and complement each other. This is what lets Bind
// scale to any goal across the full marketplace without hand-tuning per agent.
//
// Falls back to null (caller uses keyword scoring) if there is no key or the call fails.
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

export interface SelectCandidate {
  agentId: string;
  name: string;
  category: string;
  description: string;
  cheapestFee: number;
  payable: boolean;
}

export interface Pick {
  agentId: string;
  reason: string;
}

export async function selectAgents(goal: string, candidates: SelectCandidate[], max = 4): Promise<Pick[] | null> {
  if (!ANTHROPIC_KEY || candidates.length === 0) return null;

  // Keep the catalog compact: payable first, then a bounded slice, short descriptions.
  const ranked = [...candidates].sort((a, b) => Number(b.payable) - Number(a.payable));
  const slice = ranked.slice(0, 70);
  const catalog = slice
    .map((c) => `${c.agentId} | ${c.payable ? "PAYABLE" : "untested"} | $${c.cheapestFee} | ${c.category} | ${c.name}: ${c.description.replace(/\s+/g, " ").slice(0, 140)}`)
    .join("\n");

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system:
        "You are Bind's routing brain. Given a user's goal and a catalog of on-chain agents, pick the SMALL set of agents that together best answer the goal. " +
        "Rules: (1) Strongly prefer agents marked PAYABLE — untested ones often reject payment and waste money; only pick an untested agent if no payable agent covers a needed angle. " +
        "(2) Pick complementary agents (different angles: data, positioning, sentiment, security, etc.), not near-duplicates. " +
        "(3) Only pick agents genuinely relevant to THIS goal — fewer, better. (4) Never pick an agent whose job is to take an action (launch/mint/swap/buy/sell) for an analytical goal. " +
        `Return ONLY JSON: {\"picks\":[{\"agentId\":\"<id>\",\"reason\":\"<why, <=12 words>\"}]} with at most ${max} picks, best first.`,
      messages: [
        { role: "user", content: [{ type: "text", text: `Goal: ${goal}\n\nCatalog (id | payability | fee | category | name: what it does):\n${catalog}\n\nPick the best (<=${max}) agents.` }] },
      ],
    });

    const block = resp.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    const valid = new Set(candidates.map((c) => c.agentId));
    const picks: Pick[] = (parsed.picks || [])
      .filter((p: any) => p && valid.has(String(p.agentId)))
      .map((p: any) => ({ agentId: String(p.agentId), reason: String(p.reason || "").slice(0, 80) }))
      .slice(0, max);
    return picks.length > 0 ? picks : null;
  } catch {
    return null;
  }
}
