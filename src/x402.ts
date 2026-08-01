// Compatibility surface for older imports. New and legacy callers share the hardened
// x402 v2 settlement gate. No route may treat a non-empty bearer header as payment proof.
import { config, type BindToolName as ToolName } from "./config.js";
import { requireX402 } from "./bind/x402-gate.js";

/** @deprecated Discovery-only v1 challenge shape. Runtime middleware emits strict v2 terms. */
export interface X402Challenge {
  x402Version: 1;
  accepts: Array<{
    scheme: "exact";
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    resource: string;
    description: string;
    mimeType: "application/json";
    maxTimeoutSeconds: number;
  }>;
}

/** @deprecated Kept for clients that inspect the old discovery helper. */
export function buildChallenge(tool: ToolName, description: string): X402Challenge {
  return {
    x402Version: 1,
    accepts: [{
      scheme: "exact",
      network: config.network,
      asset: config.usdtAsset,
      amount: config.prices[tool],
      payTo: config.payToAddress,
      resource: `${config.publicBaseUrl}/${tool}`,
      description,
      mimeType: "application/json",
      maxTimeoutSeconds: 120,
    }],
  };
}

/** Compatibility wrapper around the strict v2 route-bound settlement middleware. */
export function requirePayment(tool: ToolName, description: string) {
  return requireX402(config.prices[tool], description);
}
