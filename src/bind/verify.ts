// Inter-step verification. Before an agent's output counts toward the deliverable
// (and before Bind proceeds/pays the next agent), it is checked here. This is the
// gate that makes Bind more than a naive chainer: an agent that returns HTTP 200 but
// an error payload, or empty data, is caught and excluded rather than silently merged.
//
// This is structural + error verification — honest about what it does. It does not
// claim to judge semantic quality; it guarantees the output is a real, non-error,
// non-empty result from the agent.
//
// Relevance verification (checkRelevance) adds the second, semantic gate: an agent can
// return perfectly-formed JSON that has nothing to do with the goal (a Polymarket
// whale-wallet feed answering a football-match question). Structure alone passes that;
// relevance catches it, so Bind stops paying for and "passing" off-topic data.
import type { BindStep } from "./types.js";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Judge whether an agent's output genuinely helps answer the goal. Fail-OPEN: if there is
 * no API key or the call errors, we do NOT reject (relevance is an extra filter, never a
 * single point of failure that could sink a good mission).
 */
export async function checkRelevance(
  goal: string,
  serviceName: string,
  serviceDescription: string,
  output: unknown,
): Promise<{ relevant: boolean; reason: string }> {
  if (!ANTHROPIC_KEY) return { relevant: true, reason: "relevance check unavailable" };
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const snippet = text.slice(0, 2500);
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system:
        "You judge whether an agent's returned data genuinely helps answer a user's goal. " +
        "Be strict about SUBJECT match: data about a different subject (e.g. crypto whale wallets when the goal is a football match, or generic top-trader lists when a specific token was asked about) is NOT relevant even if well-formed. " +
        "But accept partial or imperfect data that still speaks to the goal's actual subject. " +
        'Return ONLY JSON: {"relevant": true|false, "reason": "<=15 words"}.',
      messages: [
        { role: "user", content: [{ type: "text", text: `Goal: ${goal}\nAgent: ${serviceName} — ${serviceDescription}\nReturned data:\n${snippet}\n\nDoes this data genuinely help answer the goal?` }] },
      ],
    });
    const block = resp.content.find((b) => b.type === "text");
    const t = block && "text" in block ? block.text : "";
    const json = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    return { relevant: parsed.relevant !== false, reason: String(parsed.reason || "").slice(0, 80) };
  } catch {
    return { relevant: true, reason: "relevance check failed open" };
  }
}

export interface StepVerdict {
  passed: boolean;
  detail: string;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function verifyStepOutput(_step: BindStep, output: unknown): StepVerdict {
  if (isEmpty(output)) {
    return { passed: false, detail: "agent returned an empty response" };
  }

  if (typeof output === "string") {
    if (/error|not found|forbidden|unauthorized|invalid/i.test(output)) {
      return { passed: false, detail: `response looks like an error: ${output.slice(0, 80)}` };
    }
    return { passed: true, detail: "non-empty text response" };
  }

  if (typeof output === "object") {
    const o = output as Record<string, unknown>;

    // OKX-style envelope: code "0" = success, anything else is an error.
    if ("code" in o && String(o.code) !== "0" && String(o.code) !== "200") {
      return { passed: false, detail: `agent error code ${String(o.code)}${o.msg ? `: ${String(o.msg)}` : ""}` };
    }
    // Generic error markers.
    if (o.error !== undefined && o.error !== null && o.error !== "") {
      return { passed: false, detail: `error field present: ${String(o.error).slice(0, 80)}` };
    }
    if (o.success === false) {
      return { passed: false, detail: "success: false" };
    }
    // If there is a data payload, it must not be empty.
    if ("data" in o && isEmpty(o.data)) {
      return { passed: false, detail: "response envelope carried no data" };
    }

    return { passed: true, detail: "structured result, no error markers" };
  }

  return { passed: true, detail: "primitive result" };
}
