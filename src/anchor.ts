// On-chain anchoring: writes a report's hash to X Layer via the onchainos CLI's
// TEE-backed wallet session -- our own code never touches a private key. Uses
// contract-call with the report hash as raw calldata sent to the burn address:
// a lightweight, well-understood "proof of existence" pattern (no contract
// deployment needed) that costs nothing, since X Layer is gas-free for this
// wallet.
//
// Degrades gracefully if the CLI isn't present in the current environment
// (e.g. not yet bundled into a deployed container) -- anchoring is a
// nice-to-have enrichment, never a hard dependency for producing a report.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Anchor } from "./report.js";

const execFileAsync = promisify(execFile);

const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || "onchainos";
const XLAYER_EIP155 = "eip155:196";

// The classic burn address: no contract code, owned by no one, can never
// execute anything. Calldata sent here is always accepted verbatim and
// permanently recorded -- unlike our OWN wallet address, which is itself a
// smart-contract (ERC-4337) account and reverts when arbitrary calldata
// doesn't match one of its function selectors (confirmed by testing: sending
// the hash to our own address failed "execution reverted" on every attempt;
// sending to this address succeeded every time).
const ANCHOR_TARGET = "0x000000000000000000000000000000000000dEaD";

export class AnchoringUnavailableError extends Error {
  constructor(msg = "onchainos CLI is not available in this environment") {
    super(msg);
    this.name = "AnchoringUnavailableError";
  }
}

interface ContractCallResponse {
  ok: boolean;
  data?: { txHash?: string; orderId?: string };
  error?: string;
}

// A fresh environment (e.g. a new container) has no persisted CLI session --
// `wallet login` with no email argument does AK (API-key) login using
// OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE from the environment, no OTP
// needed. Cached in-process so we don't re-run it on every single anchor
// call; a session-expiry retry clears the cache and logs in again once.
let loggedIn = false;

async function login(): Promise<void> {
  try {
    await execFileAsync(ONCHAINOS_BIN, ["wallet", "login"], { timeout: 20000 });
    loggedIn = true;
  } catch (e) {
    // Surface the CLI's own error message (e.g. missing OKX_API_KEY/
    // OKX_SECRET_KEY/OKX_PASSPHRASE) instead of Node's generic wrapper.
    throw new Error(extractCliError(e) ?? (e as Error).message);
  }
}

async function runContractCall(hashHex: string): Promise<string> {
  const result = await execFileAsync(
    ONCHAINOS_BIN,
    [
      "wallet", "contract-call",
      "--to", ANCHOR_TARGET,
      "--chain", "xlayer",
      "--input-data", `0x${hashHex}`,
      "--biz-type", "dapp",
      "--force",
    ],
    { timeout: 45000 },
  );
  return result.stdout;
}

function extractCliError(e: unknown): string | undefined {
  const err = e as NodeJS.ErrnoException & { stdout?: string };
  if (!err.stdout) return undefined;
  try {
    return (JSON.parse(err.stdout) as ContractCallResponse).error;
  } catch {
    return undefined;
  }
}

// Anchors a hex-encoded hash (no "0x" prefix) by sending it as calldata to the
// burn address. `walletAddress` is the sender (our agentic wallet) -- required
// so we fail fast if payment/wallet config is missing, not because it's the
// on-chain recipient.
export async function anchorHash(hashHex: string, walletAddress: string): Promise<Anchor> {
  if (!walletAddress) {
    throw new AnchoringUnavailableError("no wallet address configured (PAY_TO_ADDRESS)");
  }
  if (!existsSync(ONCHAINOS_BIN)) {
    throw new AnchoringUnavailableError();
  }

  if (!loggedIn) {
    try {
      await login();
    } catch (e) {
      throw new Error(`onchainos wallet login failed: ${(e as Error).message}`);
    }
  }

  let stdout: string;
  try {
    stdout = await runContractCall(hashHex);
  } catch (e) {
    const cliError = extractCliError(e);
    // Session expired mid-flight (e.g. after a long-idle container): log in
    // again and retry exactly once, rather than fail every call thereafter.
    if (cliError?.toLowerCase().includes("session expired")) {
      loggedIn = false;
      try {
        await login();
        stdout = await runContractCall(hashHex);
      } catch (e2) {
        const retryError = extractCliError(e2);
        throw new Error(`anchor transaction rejected after re-login: ${retryError ?? (e2 as Error).message}`);
      }
    } else {
      throw new Error(cliError
        ? `anchor transaction rejected: ${cliError}`
        : `anchor transaction failed: ${(e as Error).message}`);
    }
  }

  let parsed: ContractCallResponse;
  try {
    parsed = JSON.parse(stdout) as ContractCallResponse;
  } catch {
    throw new Error(`anchor transaction returned non-JSON output: ${stdout.slice(0, 300)}`);
  }
  if (!parsed.ok || !parsed.data?.txHash) {
    throw new Error(`anchor transaction rejected: ${parsed.error ?? "unknown error"}`);
  }
  return { chain: XLAYER_EIP155, txHash: parsed.data.txHash };
}
