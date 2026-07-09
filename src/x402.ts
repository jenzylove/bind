// Seller-side x402 (v1 body form). Vouch is the resource server: it answers an
// unpaid request with HTTP 402 + an `accepts` challenge, and serves the result once
// a payment proof is presented. OKX's `agent x402-check` / `x402-validate` read this
// challenge to extract pricing; the buyer's `payment pay` settles against `payTo`.
//
// Spec: https://x402.org — keep the wire field names (`x402Version`, `accepts`,
// `X-PAYMENT`) byte-for-byte; they are externally defined and changing them breaks interop.
import type { Request, Response, NextFunction } from "express";
import { config, isConfiguredForPayment, type BindToolName as ToolName } from "./config.js";

export interface X402Challenge {
  x402Version: 1;
  accepts: Array<{
    scheme: "exact";
    network: string;
    asset: string;
    amount: string; // base units, as a string
    payTo: string;
    resource: string;
    description: string;
    mimeType: "application/json";
    maxTimeoutSeconds: number;
  }>;
}

export function buildChallenge(tool: ToolName, description: string): X402Challenge {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        asset: config.usdtAsset,
        amount: config.prices[tool],
        payTo: config.payToAddress,
        resource: `${config.publicBaseUrl}/${tool}`,
        description,
        mimeType: "application/json",
        maxTimeoutSeconds: 120,
      },
    ],
  };
}

// Express middleware factory: gate a route behind an x402 payment for `tool`.
// Presenting an `X-PAYMENT` header is currently accepted as proof (STUB). Real
// facilitator verification against X Layer is wired in Phase 1 once the OKX
// Payment SDK / facilitator endpoint is confirmed — see verifyPayment() below.
export function requirePayment(tool: ToolName, description: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Dev/calibration bypass: run the engine without a wallet or payment.
    // Never set ALLOW_UNPAID=1 in a deployed environment.
    if (process.env.ALLOW_UNPAID === "1") { next(); return; }

    if (!isConfiguredForPayment()) {
      res.status(503).json({
        error: "payment_not_configured",
        message:
          "Vouch has no payTo/asset configured yet (Agentic Wallet setup pending). " +
          "The service is not accepting paid calls.",
      });
      return;
    }

    const proof =
      req.header("Authorization")?.startsWith("X402 ")
        ? req.header("Authorization")!.slice(5)
        : req.header("X-PAYMENT") ?? req.header("PAYMENT-SIGNATURE");
    if (!proof) {
      // Unpaid: emit the x402 challenge. v1 form carries it in the body.
      res.status(402).json(buildChallenge(tool, description));
      return;
    }

    const ok = await verifyPayment(tool, proof, req);
    if (!ok) {
      res.status(402).json({ error: "payment_invalid", ...buildChallenge(tool, description) });
      return;
    }
    next();
  };
}

// TODO(Phase 1): verify the payment proof against an X Layer facilitator (OKX
// Payment SDK). Must confirm: correct asset, amount >= price, payTo == our address,
// and that the authorization has not been replayed. Until then this is a stub that
// accepts any non-empty proof so the endpoint shape can be exercised end-to-end.
async function verifyPayment(_tool: ToolName, proof: string, _req: Request): Promise<boolean> {
  return proof.trim().length > 0;
}
