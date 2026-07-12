// Agent param inference — reads service descriptions and figures out what params to send
// Uses the service description text to build correct request bodies for any A2MCP agent

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

interface InferredParams {
  method: "POST" | "GET";
  body: Record<string, unknown>;
}

export async function inferParams(
  serviceName: string,
  serviceDescription: string,
  endpoint: string,
  goal: string,
): Promise<InferredParams> {
  // Default fallback — try generic formats
  const defaults: InferredParams = { method: "POST", body: { q: goal } };

  if (!ANTHROPIC_KEY) return defaults;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: "You are an API integration assistant. You read service descriptions of OKX marketplace agents and determine the correct HTTP method and JSON parameters to call them with, given a user's goal. Respond ONLY with valid JSON: {\"method\": \"POST\" or \"GET\", \"body\": {...}}. Use empty object for GET requests. Use the example parameters in the description as a template. If the description says 'no required fields', send empty body on POST.",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `Service name: ${serviceName}\n\nDescription: ${serviceDescription}\n\nEndpoint: ${endpoint}\n\nUser goal: ${goal}\n\nWhat HTTP method and JSON body should be sent to call this service?` },
        ],
      }],
    });

    const textBlock = resp.content.find((b) => b.type === "text");
    const text = textBlock && "text" in textBlock ? textBlock.text : "";
    const parsed = JSON.parse(text);
    return {
      method: parsed.method === "GET" ? "GET" : "POST",
      body: parsed.body || {},
    };
  } catch {
    return defaults;
  }
}

// Faster path — regex-based extraction for well-documented descriptions
// Falls back to LLM if regex can't parse
export function extractParamsFast(description: string): { required: string[]; optional: string[]; example: Record<string, string> } | null {
  const required: string[] = [];
  const optional: string[] = [];
  const example: Record<string, string> = {};

  // Extract "Requires X, Y" or "Required: X, Y" or "Requires X, Y and Z" patterns
  const reqMatch = description.match(/(?:requires?|required)[:\s]+([^.]+?)(?:\s*\.\s|$)/i);
  if (reqMatch) {
    reqMatch[1].split(",").forEach((p) => {
      const trimmed = p.trim().split("=")[0].trim().split(/\s+/)[0].trim(); // "chainIndex=1" → "chainIndex", "address" → "address"
      if (trimmed && trimmed !== "optional") required.push(trimmed);
    });
  }
  // Try also "POST only. Requires chainIndex, address." pattern
  const reqMatch2 = description.match(/requires[:\s]+([^.]+?)(?:\s*\.\s|$)/i);
  if (reqMatch2 && !reqMatch) {
    reqMatch2[1].split(",").forEach((p) => {
      const trimmed = p.trim().split("=")[0].trim().split(/\s+/)[0].trim();
      if (trimmed) required.push(trimmed);
    });
  }

  // Extract "Optional: X, Y" patterns
  const optMatch = description.match(/optional[:\s]+([^.]+)/i);
  if (optMatch) {
    optMatch[1].split(",").forEach((p) => {
      const trimmed = p.trim().split("=")[0].trim();
      if (trimmed) optional.push(trimmed);
    });
  }

  // Extract example JSON bodies
  const exampleMatches = description.match(/\{[^}]+\}/g);
  if (exampleMatches) {
    for (const ex of exampleMatches) {
      try {
        const obj = JSON.parse(ex);
        for (const [k, v] of Object.entries(obj)) {
          if (!example[k]) example[k] = String(v);
        }
      } catch { /* skip non-JSON braces */ }
    }
  }

  if (required.length === 0 && Object.keys(example).length === 0) return null;

  return { required, optional, example };
}