// Agent reputation recorded from Bind execution attempts.
//
// The dataset distinguishes attempts, verification outcomes, recorded fee amounts and
// settlement transaction references. Public views expose commitments instead of raw buyer
// goals or verification details.
//
// Source of truth is the execution store on the volume, so reputation survives redeploys.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAttempt, BindExecution, ExecutionResult } from "./types.js";
import { hashCanonical } from "./receipt.js";

const DIR = process.env.BIND_DATA_DIR ?? "data/bind";
const CACHE_TTL_MS = 60_000;

export interface AgentRep {
  agentId: string;
  name: string;
  missions: number;   // recorded calls attempted
  passed: number;     // outputs that cleared verification
  failed: number;     // errored or failed verification
  feesWithSettlementReferenceUsdt: number; // recorded fees with seller-supplied tx references
  referencedMissions: number;
  referencedPassed: number;
  referencedPassRate: number;
  passRate: number;   // 0..1
}

let cache: { at: number; reps: Map<string, AgentRep> } | null = null;

function readExecutions(): BindExecution[] {
  try {
    const dir = join(DIR, "executions");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(dir, f), "utf8")) as BindExecution; } catch { return null; }
      })
      .filter((e): e is BindExecution => !!e);
  } catch {
    return []; // no missions yet
  }
}

function recordedAttempts(step: ExecutionResult): AgentAttempt[] {
  if (Array.isArray(step.attempts) && step.attempts.length > 0) return step.attempts;
  if (!["passed", "failed", "errored"].includes(step.status)) return [];
  return [{
    agentId: step.agentId,
    agentName: step.agentName,
    serviceName: step.serviceName,
    feeUsdt: step.feeUsdt,
    paid: step.feeUsdt != null && step.feeUsdt > 0,
    status: step.status as AgentAttempt["status"],
    paymentTxHash: step.paymentTxHash,
    input: step.input,
    output: step.output,
    verificationDetail: step.verificationResult?.detail,
    error: step.error,
  }];
}

export function agentReputation(): Map<string, AgentRep> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.reps;

  const reps = new Map<string, AgentRep>();
  for (const exec of readExecutions()) {
    for (const step of exec.stepResults ?? []) {
      for (const attempt of recordedAttempts(step)) {
        // Key by NAME so an agent's whole history aggregates: older records predate agentId.
        const key = attempt.agentName || attempt.agentId;
        if (!key) continue;
        const r = reps.get(key) ?? { agentId: attempt.agentId || key, name: attempt.agentName || key, missions: 0, passed: 0, failed: 0, feesWithSettlementReferenceUsdt: 0, referencedMissions: 0, referencedPassed: 0, referencedPassRate: 0, passRate: 0 };
        if (attempt.agentId) r.agentId = attempt.agentId;
        r.missions += 1;
        if (attempt.status === "passed") r.passed += 1;
        else r.failed += 1;
        // A seller-provided transaction hash is a reference, not independent confirmation.
        if (attempt.paymentTxHash && /^0x[0-9a-fA-F]{64}$/.test(attempt.paymentTxHash)) {
          r.referencedMissions += 1;
          if (attempt.status === "passed") r.referencedPassed += 1;
          r.feesWithSettlementReferenceUsdt += attempt.feeUsdt ?? 0;
        }
        reps.set(key, r);
      }
    }
  }
  for (const r of reps.values()) {
    r.passRate = r.missions ? r.passed / r.missions : 0;
    r.referencedPassRate = r.referencedMissions ? r.referencedPassed / r.referencedMissions : 0;
  }

  cache = { at: now, reps };
  return reps;
}

/** Track record for one agent. Reputation is keyed by name (merges old + new records). */
export function repFor(agentId: string, name?: string): AgentRep | null {
  const reps = agentReputation();
  if (name && reps.has(name)) return reps.get(name)!;
  for (const r of reps.values()) if (r.agentId === agentId) return r;
  return null;
}

/** Compact line for the routing prompt, e.g. "94% verified over 17 calls". */
export function repSummary(agentId: string, name?: string): string | null {
  const r = repFor(agentId, name);
  if (!r || r.missions < 2) return null;   // one data point is not a track record
  return `${Math.round(r.passRate * 100)}% verified over ${r.missions} recorded calls`;
}

// An agent with a real, repeated record of never delivering should not be hired again,
// no matter how well it matches the goal. This is the ledger doing its job: Optic AI took
// payment on 5 missions and delivered verified work on none of them.
const MIN_EVIDENCE = 3;
const FIRE_BELOW = 0.34;
export function isProvenBad(agentId: string, name?: string): boolean {
  const r = repFor(agentId, name);
  return !!r && r.referencedMissions >= MIN_EVIDENCE && r.referencedPassRate < FIRE_BELOW;
}

export function allReputation(): AgentRep[] {
  return [...agentReputation().values()].sort((a, b) => b.missions - a.missions);
}

function evidenceId(executionId: string, audience: string): string {
  // executionId is a random UUID and is intentionally not returned by aggregate APIs.
  // Audience separation prevents correlation between wallet and agent views.
  return `sha256:${hashCanonical({ schema: "bind-evidence-id-v1", audience, executionId })}`;
}

/** One agent's full track record + hire-by-hire evidence, for the public seller page. */
export function agentEvidence(agentId: string): { rep: AgentRep | null; evidence: Array<{ at: string; evidenceId: string; serviceName?: string; status: string; feeUsdt?: number; settlementReference?: string }> } {
  const rep = [...agentReputation().values()].find((r) => r.agentId === agentId) ?? null;
  const evidence: ReturnType<typeof agentEvidence>["evidence"] = [];
  for (const exec of readExecutions()) {
    for (const step of exec.stepResults ?? []) {
      for (const attempt of recordedAttempts(step)) {
        const match = attempt.agentId === agentId || (rep && attempt.agentName === rep.name);
        if (!match) continue;
        evidence.push({
          at: exec.createdAt,
          evidenceId: evidenceId(exec.executionId, `agent:${agentId}`),
          serviceName: attempt.serviceName,
          status: attempt.status,
          feeUsdt: attempt.feeUsdt,
          settlementReference: attempt.paymentTxHash && /^0x[0-9a-fA-F]{64}$/.test(attempt.paymentTxHash) ? attempt.paymentTxHash : undefined,
        });
      }
    }
  }
  evidence.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { rep, evidence: evidence.slice(0, 60) };
}

/**
 * The paid product: the full evidence behind the leaderboard. Per-agent hire-by-hire
 * outcomes with settlement tx hashes, newest first. This is data only Bind has — earned
 * by paying real money — so unlike the free summary it is sold via x402.
 */
export function ledgerDetail(limit = 200): {
  leaderboard: AgentRep[];
  evidence: Array<{ at: string; evidenceId: string; agentId?: string; agent: string; serviceName?: string; status: string; feeUsdt?: number; settlementReference?: string }>;
} {
  const evidence: ReturnType<typeof ledgerDetail>["evidence"] = [];
  for (const exec of readExecutions()) {
    for (const step of exec.stepResults ?? []) {
      for (const attempt of recordedAttempts(step)) {
        const audience = `agent:${attempt.agentId ?? attempt.agentName ?? "unknown"}`;
        evidence.push({
          at: exec.createdAt,
          evidenceId: evidenceId(exec.executionId, audience),
          agentId: attempt.agentId,
          agent: attempt.agentName,
          serviceName: attempt.serviceName,
          status: attempt.status,
          feeUsdt: attempt.feeUsdt,
          settlementReference: attempt.paymentTxHash && /^0x[0-9a-fA-F]{64}$/.test(attempt.paymentTxHash) ? attempt.paymentTxHash : undefined,
        });
      }
    }
  }
  evidence.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { leaderboard: allReputation(), evidence: evidence.slice(0, limit) };
}
