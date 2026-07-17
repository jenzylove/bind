// Agent reputation, earned from real missions.
//
// This is the asset the marketplace does not have and a competitor cannot clone on day
// one: every mission Bind runs is a paid, verified, on-chain-anchored data point about
// whether an agent actually delivered. We aggregate those into a per-agent track record
// and use it to route (and to show the buyer why a crew was chosen).
//
// Source of truth is the execution store on the volume, so reputation survives redeploys.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BindExecution } from "./types.js";

const DIR = process.env.BIND_DATA_DIR ?? "data/bind";
const CACHE_TTL_MS = 60_000;

export interface AgentRep {
  agentId: string;
  name: string;
  missions: number;   // times hired
  passed: number;     // outputs that cleared verification
  failed: number;     // errored or failed verification
  paidUsdt: number;   // total actually paid to this agent
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

export function agentReputation(): Map<string, AgentRep> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.reps;

  const reps = new Map<string, AgentRep>();
  for (const exec of readExecutions()) {
    for (const step of exec.stepResults ?? []) {
      // Key by NAME so an agent's whole history aggregates: older records predate agentId
      // and are keyed by name, newer ones carry both. Keying by id would split the two.
      const key = step.agentName || step.agentId;
      if (!key) continue;
      const r = reps.get(key) ?? { agentId: step.agentId || key, name: step.agentName || key, missions: 0, passed: 0, failed: 0, paidUsdt: 0, passRate: 0 };
      if (step.agentId) r.agentId = step.agentId;
      r.missions += 1;
      if (step.status === "passed") r.passed += 1;
      else if (step.status === "failed" || step.status === "errored") r.failed += 1;
      // Only count money that actually moved (a real settlement tx, not "no_payment_needed").
      if (step.paymentTxHash?.startsWith("0x")) r.paidUsdt += step.feeUsdt ?? 0;
      reps.set(key, r);
    }
  }
  for (const r of reps.values()) r.passRate = r.missions ? r.passed / r.missions : 0;

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

/** Compact line for the routing prompt, e.g. "94% verified over 17 missions". */
export function repSummary(agentId: string, name?: string): string | null {
  const r = repFor(agentId, name);
  if (!r || r.missions < 2) return null;   // one data point is not a track record
  return `${Math.round(r.passRate * 100)}% verified over ${r.missions} missions`;
}

// An agent with a real, repeated record of never delivering should not be hired again,
// no matter how well it matches the goal. This is the ledger doing its job: Optic AI took
// payment on 5 missions and delivered verified work on none of them.
const MIN_EVIDENCE = 3;
const FIRE_BELOW = 0.34;
export function isProvenBad(agentId: string, name?: string): boolean {
  const r = repFor(agentId, name);
  return !!r && r.missions >= MIN_EVIDENCE && r.passRate < FIRE_BELOW;
}

export function allReputation(): AgentRep[] {
  return [...agentReputation().values()].sort((a, b) => b.missions - a.missions);
}

/** Mission history for one buyer wallet, newest first. Older records predate payer tracking. */
export function historyFor(payer: string): Array<{ executionId: string; goal: string; status: string; totalPaid: number; refundedUsdt?: number; createdAt: string }> {
  const p = (payer || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(p)) return [];
  return readExecutions()
    .filter((e) => (e.payer || "").toLowerCase() === p)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 50)
    .map((e) => ({ executionId: e.executionId, goal: e.goal, status: e.status, totalPaid: e.totalPaid, refundedUsdt: e.refundedUsdt, createdAt: e.createdAt }));
}

/** One agent's full track record + hire-by-hire evidence, for the public seller page. */
export function agentEvidence(agentId: string): { rep: AgentRep | null; evidence: Array<{ at: string; goal: string; status: string; feeUsdt?: number; settlementTx?: string; detail?: string }> } {
  const rep = [...agentReputation().values()].find((r) => r.agentId === agentId) ?? null;
  const evidence: ReturnType<typeof agentEvidence>["evidence"] = [];
  for (const exec of readExecutions()) {
    for (const step of exec.stepResults ?? []) {
      const match = step.agentId === agentId || (rep && step.agentName === rep.name);
      if (!match) continue;
      evidence.push({
        at: exec.createdAt, goal: exec.goal, status: step.status, feeUsdt: step.feeUsdt,
        settlementTx: step.paymentTxHash?.startsWith("0x") ? step.paymentTxHash : undefined,
        detail: step.verificationResult?.detail,
      });
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
  evidence: Array<{ at: string; goal: string; agentId?: string; agent: string; status: string; feeUsdt?: number; settlementTx?: string; verification?: string }>;
} {
  const evidence: ReturnType<typeof ledgerDetail>["evidence"] = [];
  for (const exec of readExecutions()) {
    for (const step of exec.stepResults ?? []) {
      evidence.push({
        at: exec.createdAt,
        goal: exec.goal,
        agentId: step.agentId,
        agent: step.agentName,
        status: step.status,
        feeUsdt: step.feeUsdt,
        settlementTx: step.paymentTxHash?.startsWith("0x") ? step.paymentTxHash : undefined,
        verification: step.verificationResult?.detail,
      });
    }
  }
  evidence.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { leaderboard: allReputation(), evidence: evidence.slice(0, limit) };
}
