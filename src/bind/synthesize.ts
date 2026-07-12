// Bind deliverable synthesis — turns the raw JSON that verified agents returned into
// ONE readable answer to the user's goal. This is the actual product: the user asked a
// question, paid several agents, and gets a coherent brief back — not a pile of JSON.
//
// If no ANTHROPIC_API_KEY is configured, we still return something readable (a plain
// per-agent summary) rather than a raw JSON dump, so the deliverable is never empty.
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

export interface AgentOutput {
  agent: string;
  role: string;
  output: unknown;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …(truncated)" : s;
}

// Fallback when there is no LLM key: a readable digest, not a raw dump.
function plainSummary(goal: string, outputs: AgentOutput[]): string {
  if (outputs.length === 0) return "No agent outputs passed verification, so there is no deliverable for this goal.";
  const parts = outputs.map((o) => {
    const body = typeof o.output === "string" ? o.output : JSON.stringify(o.output);
    return `• ${o.agent} (${o.role}):\n${truncate(body, 600)}`;
  });
  return `Results for: "${goal}"\n\nBind paid and verified ${outputs.length} agent(s). Here is what each returned:\n\n${parts.join("\n\n")}`;
}

export async function synthesizeDeliverable(goal: string, outputs: AgentOutput[]): Promise<string> {
  if (outputs.length === 0) {
    return "No agent outputs passed verification, so there is no deliverable for this goal. Try rephrasing or funding a broader plan.";
  }
  if (!ANTHROPIC_KEY) return plainSummary(goal, outputs);

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const evidence = outputs
      .map((o) => `### ${o.agent} (role: ${o.role})\n${truncate(typeof o.output === "string" ? o.output : JSON.stringify(o.output, null, 2), 4000)}`)
      .join("\n\n");

    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 900,
      system:
        "You are Bind, an orchestrator that hired several specialized on-chain agents to answer a user's goal and must now hand back ONE clear deliverable. " +
        "Write a direct, decision-useful answer to the goal using ONLY the agent evidence provided. " +
        "Lead with a one-line verdict/answer, then 3-6 tight bullet points of the specific facts that support it (cite which agent each came from). " +
        "If the evidence is thin or contradictory, say so plainly. Never invent data not present in the evidence. No preamble, no markdown headers, under 200 words.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `User goal:\n${goal}\n\nAgent evidence:\n${evidence}\n\nWrite the final deliverable.` }],
        },
      ],
    });

    const block = resp.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text.trim() : "";
    return text || plainSummary(goal, outputs);
  } catch {
    return plainSummary(goal, outputs);
  }
}
