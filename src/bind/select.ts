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
  /** The exact service Bind will call for this agent — the thing the router must match on. */
  service: string;
  cheapestFee: number;
  payable: boolean;
  /** Track record earned on real missions, e.g. "94% verified over 17 missions". */
  track?: string | null;
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
  // Lead each line with the SERVICE that will actually be invoked. Routing on the vendor's
  // profile blurb alone mis-hires badly (a rug-scan goal hired a price feed because the
  // vendor reads as a generic markets company).
  const catalog = slice
    .map((c) => `${c.agentId} | ${c.payable ? "PAYABLE" : "untested"}${c.track ? ` | TRACK: ${c.track}` : ""} | $${c.cheapestFee} | ${c.category} | SERVICE: "${c.service}" (by ${c.name}) :: ${c.description.replace(/\s+/g, " ").slice(0, 120)}`)
    .join("\n");

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system:
        "You are Bind's routing brain. Given a user's goal and a catalog of on-chain agents, pick the SMALL set of agents that together best answer the goal. " +
        "TRACK shows an agent's real record on past Bind missions (verified pass rate). Prefer a proven track record over an unproven agent when both fit. " +
        "Rules: (1) PAYABILITY IS PARAMOUNT. Agents marked PAYABLE reliably settle and return data; untested ones almost always reject payment and produce nothing. Fill your picks with PAYABLE agents first. Include AT MOST ONE untested agent, and ONLY if it covers an essential angle that NO payable agent can — otherwise pick all-payable. " +
        "(2) NEVER pad to the limit. Hire the FEWEST agents that fully cover the goal: one agent is correct for a narrow question, two is typical, three only when the goal genuinely has three distinct angles. The buyer pays for every agent you hire and each one can fail, so an unnecessary hire is a real cost, not a bonus. " +
        "(3) Never hire two agents that cover the SAME angle (e.g. two market-data feeds). Each hire must add something the others cannot. " +
        "(4) Only pick agents genuinely relevant to THIS goal. (5) Never pick an agent whose job is to take an action (launch/mint/swap/buy/sell) for an analytical goal. " +
        `Return ONLY JSON: {\"picks\":[{\"agentId\":\"<id>\",\"reason\":\"<why, <=12 words>\"}]} with AT MOST ${max} picks (fewer is better), best first.`,
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
