// Inter-step verification. Before an agent's output counts toward the deliverable
// (and before Bind proceeds/pays the next agent), it is checked here. This is the
// gate that makes Bind more than a naive chainer: an agent that returns HTTP 200 but
// an error payload, or empty data, is caught and excluded rather than silently merged.
//
// This is structural + error verification — honest about what it does. It does not
// claim to judge semantic quality; it guarantees the output is a real, non-error,
// non-empty result from the agent.
import type { BindStep } from "./types.js";

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
