// Bind runtime configuration
export const config = {
  port: Number(process.env.PORT ?? 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,

  // x402 payment target — Agentic Wallet on X Layer
  payToAddress: process.env.PAY_TO_ADDRESS ?? "",
  usdtAsset: process.env.USDT_ASSET ?? "",
  usdtDecimals: Number(process.env.USDT_DECIMALS ?? 6),

  // X Layer
  network: "eip155:196",

  // Bind service prices (USDT base units, 6 decimals — 1_000_000 = 1 USDT)
  prices: {
    bind_plan: process.env.PRICE_BIND_PLAN ?? "50000",       // 0.05 USDT
    bind_execute: process.env.PRICE_BIND_EXECUTE ?? "500000", // 0.50 USDT
    // The reputation ledger, sold as data: full hire-by-hire evidence with tx hashes.
    bind_reputation: process.env.PRICE_BIND_REPUTATION ?? "10000", // 0.01 USDT
  },
} as const;

export type BindToolName = keyof typeof config.prices;

export function isConfiguredForPayment(): boolean {
  return config.payToAddress !== "" && config.usdtAsset !== "";
}