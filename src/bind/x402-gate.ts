// Seller-side x402 for Bind's registered ASP endpoints.
//
// Bind is listed on OKX.AI as an x402 ASP, so a buyer AGENT must be able to call
// /bind/plan and /bind/execute, receive an HTTP 402 payment challenge, sign against it,
// and retry to get the deliverable. Without this the listing is rejected as x402_invalid
// ("no accepts entry matches USDT; available assets: empty").
//
// The challenge is the exact v2 shape the OKX signer and other live agents use (verified
// by decoding real challenges from SignalDesk/Newsliquid): x402Version 2, a single `exact`
// accepts entry on eip155:196 priced in USD₮0, delivered in the `PAYMENT-REQUIRED` header
// AND the body. The human website does NOT use these routes — it has its own free quote +
// wallet-pay flow — so gating here never touches that path.
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

const USDT = config.usdtAsset;      // 0x779ded…736
const PAYTO = config.payToAddress;  // Bind's agentic wallet

export function x402Challenge(amountBaseUnits: string, resourceUrl: string, description: string) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:196",
        amount: String(amountBaseUnits),
        asset: USDT,
        payTo: PAYTO,
        maxTimeoutSeconds: 300,
        extra: { name: "USD₮0", version: "1" },
      },
    ],
  };
}

function hasPayment(req: Request): boolean {
  const h = req.headers;
  return Boolean(
    h["payment-signature"] ||
    h["x-payment"] ||
    String(h["authorization"] || "").toUpperCase().startsWith("X402"),
  );
}

/**
 * Gate a route behind an x402 payment. An unpaid request (bare OR with a body) gets a 402
 * challenge; a request carrying a payment header falls through to the real handler.
 */
export function requireX402(amountBaseUnits: string, description: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasPayment(req)) { next(); return; }
    const url = `${config.publicBaseUrl}${req.originalUrl.split("?")[0]}`;
    const challenge = x402Challenge(amountBaseUnits, url, description);
    const b64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
    res.setHeader("PAYMENT-REQUIRED", b64);
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    res.status(402).json(challenge);
  };
}
