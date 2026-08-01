import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  authorizationClaimKey,
  directPaymentClaimKey,
  loadPaymentClaim,
  outstandingPaymentLiabilityBaseUnits,
  recoverStalePaymentClaimLocks,
  reservePaymentClaim,
  transitionPaymentClaim,
} from "../src/bind/payment-claims.js";

const token = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const txHash = `0x${"a".repeat(64)}`;

function raceWorker(dir: string, key: string): Promise<number> {
  const source = `import {reservePaymentClaim} from './src/bind/payment-claims.ts'; const ok=reservePaymentClaim({key:${JSON.stringify(key)},source:'direct_transfer',chain:'eip155:196',token:${JSON.stringify(token)},txHash:${JSON.stringify(txHash)}},${JSON.stringify(dir)}); process.exit(ok?0:3);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", source], { cwd: process.cwd(), stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 99));
  });
}

test("only one process can atomically reserve a payment and the claim survives exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-claims-"));
  try {
    const key = directPaymentClaimKey(token, txHash);
    const codes = await Promise.all(Array.from({ length: 8 }, () => raceWorker(dir, key)));
    assert.equal(codes.filter((code) => code === 0).length, 1);
    assert.equal(codes.filter((code) => code === 3).length, 7);
    const claim = loadPaymentClaim(key, dir);
    assert.equal(claim?.state, "reserved");
    assert.equal(claim?.txHash, txHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downstream authorization claims preserve payer nonce exposure across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-claims-"));
  try {
    const payer = "0x3333333333333333333333333333333333333333";
    const nonce = `0x${"b".repeat(64)}`;
    const key = authorizationClaimKey(token, payer, nonce);
    assert.equal(reservePaymentClaim({
      key,
      source: "downstream_x402",
      chain: "eip155:196",
      token,
      payer,
      nonce,
      amountBaseUnits: "15000",
      executionId: "exec-1",
      route: "POST https://agent.example/x402/run",
    }, dir), true);
    transitionPaymentClaim(key, ["reserved"], "submitting", {}, dir);
    assert.equal(loadPaymentClaim(key, dir)?.state, "submitting");
    assert.equal(reservePaymentClaim({ key, source: "downstream_x402", chain: "eip155:196", token, payer, nonce }, dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settled and completed claims cannot be reserved or rewound", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-claims-"));
  try {
    const key = directPaymentClaimKey(token, txHash);
    assert.equal(reservePaymentClaim({ key, source: "direct_transfer", chain: "eip155:196", token, txHash }, dir), true);
    transitionPaymentClaim(key, ["reserved"], "settled", {}, dir);
    transitionPaymentClaim(key, ["settled"], "execution_started", { executionId: "exec-1" }, dir);
    transitionPaymentClaim(key, ["execution_started"], "completed", {}, dir);
    assert.equal(reservePaymentClaim({ key, source: "direct_transfer", chain: "eip155:196", token, txHash }, dir), false);
    assert.throws(() => transitionPaymentClaim(key, ["reserved"], "settled", {}, dir), /completed/);
    assert.equal(loadPaymentClaim(key, dir)?.executionId, "exec-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserve ledger sums unresolved claims exactly and can exclude only the current payment", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-claims-reserve-"));
  try {
    const currentKey = directPaymentClaimKey(token, `0x${"c".repeat(64)}`);
    const priorKey = directPaymentClaimKey(token, `0x${"d".repeat(64)}`);
    const downstreamKey = authorizationClaimKey(token, "0x3333333333333333333333333333333333333333", `0x${"e".repeat(64)}`);
    for (const [key, source, amount] of [
      [currentKey, "incoming_x402", "50000"],
      [priorKey, "incoming_x402", "70000"],
      [downstreamKey, "downstream_x402", "15000"],
    ] as const) {
      reservePaymentClaim({ key, source, chain: "eip155:196", token, amountBaseUnits: amount }, dir);
      transitionPaymentClaim(key, ["reserved"], source === "downstream_x402" ? "submitting" : "settled", {}, dir);
    }
    assert.equal(outstandingPaymentLiabilityBaseUnits(dir), 135000n);
    assert.equal(outstandingPaymentLiabilityBaseUnits(dir, new Set([currentKey])), 85000n);
    transitionPaymentClaim(priorKey, ["settled"], "completed", {}, dir);
    assert.equal(outstandingPaymentLiabilityBaseUnits(dir, new Set([currentKey])), 15000n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserve ledger fails closed on a malformed unresolved amount", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-claims-reserve-"));
  try {
    const key = directPaymentClaimKey(token, `0x${"f".repeat(64)}`);
    reservePaymentClaim({ key, source: "incoming_x402", chain: "eip155:196", token, amountBaseUnits: "1.5" }, dir);
    transitionPaymentClaim(key, ["reserved"], "settled", {}, dir);
    assert.throws(() => outstandingPaymentLiabilityBaseUnits(dir), /invalid unresolved amount/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup recovers only an old claim lock whose owner process is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "bind-claims-lock-"));
  try {
    const key = directPaymentClaimKey(token, `0x${"9".repeat(64)}`);
    reservePaymentClaim({ key, source: "incoming_x402", chain: "eip155:196", token, amountBaseUnits: "50000" }, dir);
    const lock = join(dir, `${key}.json.lock`);
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, createdAt: "2000-01-01T00:00:00.000Z" }));
    utimesSync(lock, new Date(0), new Date(0));
    assert.equal(recoverStalePaymentClaimLocks(dir, 60_000), 1);
    transitionPaymentClaim(key, ["reserved"], "settled", {}, dir);
    assert.equal(loadPaymentClaim(key, dir)?.state, "settled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
