// Refund the agent budget a mission never spent.
//
// The buyer prepays the quote (agent cost + Bind's fee). If an agent flakes, Bind never
// pays it, so that money would otherwise just sit in Bind's wallet. Keeping it would mean
// charging for work nobody did, which is precisely what Bind exists to stop. So anything
// quoted-but-unspent goes back to the buyer automatically.
//
// Bind's platform fee is earned (routing, verification, receipt) and is not refunded.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
// Below this, an on-chain refund costs more in friction than it returns.
const MIN_REFUND_USDT = 0.004;

export interface RefundResult { refunded: number; txHash?: string; reason?: string; }

function transferCalldata(to: string, amountBaseUnits: bigint): string {
  const addr = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = amountBaseUnits.toString(16).padStart(64, "0");
  return "0xa9059cbb" + addr + amt; // transfer(address,uint256)
}

/**
 * Refund the quoted cost of agents that did not deliver verified work.
 * @param quotedAgentCost what the buyer was charged for agents
 * @param deliveredCost   cost of only the agents that PASSED verification (what the buyer keeps paying for)
 * @param payer           the buyer's address (from the payment's Transfer log)
 */
export async function refundUnspent(quotedAgentCost: number, deliveredCost: number, payer?: string): Promise<RefundResult> {
  const unspent = Math.round((quotedAgentCost - deliveredCost) * 1e6) / 1e6;
  if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) return { refunded: 0, reason: "no payer address on record" };
  if (unspent < MIN_REFUND_USDT) return { refunded: 0, reason: unspent <= 0 ? "full budget was spent" : "below refund threshold" };
  if (!config.usdtAsset) return { refunded: 0, reason: "server misconfigured: no token address" };

  try {
    const data = transferCalldata(payer, BigInt(Math.round(unspent * 1e6)));
    const { stdout } = await execFileAsync(
      ONCHAINOS_PATH,
      ["wallet", "contract-call", "--to", config.usdtAsset, "--chain", "196", "--input-data", data],
      { timeout: 45000 },
    );
    const parsed = JSON.parse(stdout);
    const txHash = parsed?.data?.txHash ?? parsed?.data?.orderId ?? parsed?.data?.hash;
    return { refunded: unspent, txHash: typeof txHash === "string" ? txHash : undefined };
  } catch (e) {
    // A failed refund must never fail the mission — the buyer still gets their deliverable.
    return { refunded: 0, reason: `refund failed: ${(e as Error).message.slice(0, 80)}` };
  }
}
