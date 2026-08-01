import { createHash } from "node:crypto";

const EVIDENCE_FIELDS = new Set(["paymentAuth", "paymentTxHash"]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  const pairs = Object.keys(object)
    .filter((key) => object[key] !== undefined && !EVIDENCE_FIELDS.has(key))
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * EIP-3009's signed nonce is Bind's request-intent commitment. A credential issued for one
 * route/body cannot authorize a different goal, plan, input set, or response mode.
 */
export function paymentIntentNonce(route: string, body: unknown): `0x${string}` {
  const normalizedRoute = String(route || "").trim();
  const digest = createHash("sha256")
    .update("bind.payment-intent.v1\n")
    .update(normalizedRoute)
    .update("\n")
    .update(canonical(body ?? {}))
    .digest("hex");
  return `0x${digest}`;
}
