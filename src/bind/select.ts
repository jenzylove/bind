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

export interface SelectResult {
  picks: Pick[];
  /** When the router genuinely cannot cover the goal, an honest explanation to show the user. */
  declineReason?: string;
}

export async function selectAgents(goal: string, candidates: SelectCandidate[], max = 4): Promise<SelectResult | null> {
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
        "You are Bind's routing brain. Bind is a GENERAL CONTRACTOR across every domain — crypto, sports, travel, images, health, prediction, anything — not a crypto-only tool. Given a user's goal and a catalog of on-chain agents, pick the SMALL set that together best answer the goal. " +
        "TRACK shows an agent's real record on past Bind missions (verified pass rate). PAYABLE marks agents already proven to settle and return data. " +
        "Rules: (1) PREFER proven (PAYABLE / good TRACK) agents WHEN THEY GENUINELY FIT the goal. But Bind verifies every output, pays only for verified work, and automatically falls back to another agent when one fails — so an untested agent is safe to try. Therefore: if the goal's domain is NOT covered by any payable agent (e.g. a sports match, a trip plan, a logo), HIRE the best-fitting untested agents for it. Do NOT decline merely because the only fitting agents are untested — a well-matched untested agent is exactly what the fallback machinery is for. " +
        "(2) NEVER pad to the limit. Hire the FEWEST agents that fully cover the goal: one agent is correct for a narrow question, two is typical, three only when the goal genuinely has three distinct angles. Each hire can fail, so an unnecessary hire is a real cost, not a bonus. " +
        "(3) Never hire two agents that cover the SAME angle (e.g. two market-data feeds). Each hire must add something the others cannot. " +
        "(4) CAPABILITY, NOT KEYWORDS, and STAY ON-DOMAIN. An agent only counts if its SERVICE actually produces what the goal asks for. Match the goal's SUBJECT: a sports match needs a sports/prediction agent; a trip needs a travel agent; a logo needs a design agent; a token needs a crypto agent. It is FORBIDDEN to hire a crypto market-data, on-chain-data, security, or DeFi agent for a non-crypto goal (a price feed cannot predict a football match or plan a trip) — doing so charges the user for useless work. So for an off-domain goal you have exactly two valid moves: hire the on-topic agent(s) even if untested, OR if the catalog truly has no on-topic agent, DECLINE (say what Bind cannot do and what it can). Never hire off-topic crypto agents as filler. " +
        "(5) Never pick an agent whose job is to take an action (launch/mint/swap/buy/sell) for an analytical goal. " +
        `Return ONLY JSON. To hire: {\"picks\":[{\"agentId\":\"<id>\",\"reason\":\"<why, <=12 words>\"}]} with AT MOST ${max} picks (fewer is better), best first. ` +
        `To decline because no agent genuinely fits: {\"picks\":[],\"decline\":\"<one honest sentence: what Bind cannot do here, and what kind of goal it can handle>\"}.`,
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
    if (picks.length > 0) return { picks };
    // The router looked and found nothing that genuinely fits — surface that honestly
    // rather than letting the heuristic fall back to keyword-matched crypto agents.
    if (typeof parsed.decline === "string" && parsed.decline.trim()) {
      return { picks: [], declineReason: parsed.decline.trim().slice(0, 220) };
    }
    return null;
  } catch {
    return null;
  }
}
