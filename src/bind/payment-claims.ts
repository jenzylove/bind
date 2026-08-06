// Durable, fail-closed ownership of incoming payment evidence.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type PaymentClaimState =
  | "reserved"
  | "submitting"
  | "settled"
  | "execution_started"
  | "completed"
  | "refund_pending"
  | "refund_submitted"
  | "refund_confirmed"
  | "reconciliation_required";

export interface PaymentClaim {
  version: 1;
  key: string;
  source: "direct_transfer" | "eip3009" | "incoming_x402" | "downstream_x402" | "refund";
  state: PaymentClaimState;
  chain: "eip155:196";
  token: string;
  payer?: string;
  sender?: string;
  nonce?: string;
  txHash?: string;
  refundTxHash?: string;
  amountBaseUnits?: string;
  executionId?: string;
  route?: string;
  requestIntent?: string;
  createdAt: string;
  updatedAt: string;
  detail?: string;
}

const DEFAULT_DIR = process.env.BIND_PAYMENT_CLAIMS_DIR
  || join(process.env.BIND_DATA_DIR || join(process.cwd(), "data"), "payment-claims");

function digest(value: string): string {
  return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

export function directPaymentClaimKey(token: string, txHash: string): string {
  return `direct-${digest(`eip155:196|${token}|${txHash}`)}`;
}

export function authorizationClaimKey(token: string, payer: string, nonce: string): string {
  return `auth-${digest(`eip155:196|${token}|${payer}|${nonce}`)}`;
}

export function refundClaimKey(liabilityId: string, token: string, payer: string, amountBaseUnits: string): string {
  return `refund-${digest(`eip155:196|${liabilityId}|${token}|${payer}|${amountBaseUnits}`)}`;
}

function claimPath(key: string, dir: string): string {
  if (!/^(direct|auth|refund)-[0-9a-f]{64}$/.test(key)) throw new Error("invalid payment claim key");
  return join(dir, `${key}.json`);
}

function syncDir(path: string): void {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableCreate(path: string, value: PaymentClaim): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDir(path);
}

function durableReplace(path: string, value: PaymentClaim): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDir(path);
}

export function loadPaymentClaim(key: string, dir = DEFAULT_DIR): PaymentClaim | undefined {
  const path = claimPath(key, dir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PaymentClaim;
    if (parsed.version !== 1 || parsed.key !== key || typeof parsed.state !== "string") throw new Error("invalid claim record");
    return parsed;
  } catch (error) {
    throw new Error(`payment claim is unreadable and requires reconciliation: ${(error as Error).message}`);
  }
}

export function listPaymentClaims(dir = DEFAULT_DIR): PaymentClaim[] {
  if (!existsSync(dir)) return [];
  const records: PaymentClaim[] = [];
  for (const name of readdirSync(dir).filter((entry) => /^(direct|auth|refund)-[0-9a-f]{64}\.json$/.test(entry)).sort()) {
    const key = name.slice(0, -5);
    records.push(loadPaymentClaim(key, dir)!);
  }
  return records;
}

const LIABILITY_STATES = new Set<PaymentClaimState>([
  "submitting",
  "settled",
  "execution_started",
  "refund_pending",
  "refund_submitted",
  "reconciliation_required",
]);

/** Exact reserve required for claims whose funds or authorizations are not terminal. */
export function outstandingPaymentLiabilityBaseUnits(
  dir = DEFAULT_DIR,
  excludeKeys: ReadonlySet<string> = new Set(),
): bigint {
  let total = 0n;
  for (const claim of listPaymentClaims(dir)) {
    if (excludeKeys.has(claim.key) || !LIABILITY_STATES.has(claim.state)) continue;
    // A settled downstream claim is already a completed wallet outflow. Ambiguous downstream
    // submissions remain liabilities because they may settle after the balance check.
    if (claim.source === "downstream_x402" && claim.state === "settled") continue;
    if (!claim.amountBaseUnits || !/^(0|[1-9][0-9]*)$/.test(claim.amountBaseUnits)) {
      throw new Error(`payment claim ${claim.key} has an invalid unresolved amount`);
    }
    total += BigInt(claim.amountBaseUnits);
  }
  return total;
}

/** Returns false when another process already owns this payment authorization. */
export function reservePaymentClaim(
  input: Omit<PaymentClaim, "version" | "state" | "createdAt" | "updatedAt">,
  dir = DEFAULT_DIR,
): boolean {
  const now = new Date().toISOString();
  const record: PaymentClaim = { ...input, version: 1, state: "reserved", createdAt: now, updatedAt: now };
  try {
    durableCreate(claimPath(input.key, dir), record);
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/** Startup-only recovery for old transition locks whose recorded process is gone. */
export function recoverStalePaymentClaimLocks(
  dir = DEFAULT_DIR,
  staleAfterMs = 5 * 60_000,
  nowMs = Date.now(),
): number {
  if (!existsSync(dir)) return 0;
  let recovered = 0;
  for (const name of readdirSync(dir).filter((entry) => /^(direct|auth|refund)-[0-9a-f]{64}\.json\.lock$/.test(entry))) {
    const lock = join(dir, name);
    const ageMs = nowMs - statSync(lock).mtimeMs;
    if (ageMs < staleAfterMs) continue;
    let ownerPid = 0;
    try {
      const metadata = JSON.parse(readFileSync(lock, "utf8")) as { pid?: unknown };
      if (typeof metadata.pid === "number") ownerPid = metadata.pid;
    } catch {
      // Empty locks were created by older Bind versions. Age is their only owner evidence.
    }
    if (processIsAlive(ownerPid)) continue;
    const quarantine = `${lock}.recovered-${randomUUID()}`;
    try {
      renameSync(lock, quarantine);
      unlinkSync(quarantine);
      syncDir(join(dir, name.slice(0, -5)));
      recovered += 1;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return recovered;
}

/** Atomic state transition. Startup recovery removes only old locks with no live owner. */
export function transitionPaymentClaim(
  key: string,
  expected: PaymentClaimState[],
  next: PaymentClaimState,
  patch: Partial<Omit<PaymentClaim, "version" | "key" | "state" | "createdAt">> = {},
  dir = DEFAULT_DIR,
): PaymentClaim {
  const path = claimPath(key, dir);
  const lock = `${path}.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lock, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw new Error("payment claim transition is locked; reconciliation required");
    throw error;
  }
  try {
    writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    fsyncSync(lockFd);
  } catch (error) {
    closeSync(lockFd);
    try { unlinkSync(lock); } catch { /* preserve the original metadata-write error */ }
    throw error;
  }
  try {
    const current = loadPaymentClaim(key, dir);
    if (!current) throw new Error("payment claim does not exist");
    if (!expected.includes(current.state)) {
      throw new Error(`payment claim is ${current.state}, expected ${expected.join(" or ")}`);
    }
    const updated: PaymentClaim = { ...current, ...patch, version: 1, key, state: next, updatedAt: new Date().toISOString() };
    durableReplace(path, updated);
    return updated;
  } finally {
    closeSync(lockFd!);
    try { unlinkSync(lock); } catch { /* a stale lock fails closed */ }
    syncDir(path);
  }
}
