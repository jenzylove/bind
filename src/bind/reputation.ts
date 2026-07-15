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
      const id = step.agentId || step.agentName;   // older records predate agentId
      if (!id) continue;
      const r = reps.get(id) ?? { agentId: id, name: step.agentName, missions: 0, passed: 0, failed: 0, paidUsdt: 0, passRate: 0 };
      r.missions += 1;
      if (step.status === "passed") r.passed += 1;
      else if (step.status === "failed" || step.status === "errored") r.failed += 1;
      // Only count money that actually moved (a real settlement tx, not "no_payment_needed").
      if (step.paymentTxHash?.startsWith("0x")) r.paidUsdt += step.feeUsdt ?? 0;
      reps.set(id, r);
    }
  }
  for (const r of reps.values()) r.passRate = r.missions ? r.passed / r.missions : 0;

  cache = { at: now, reps };
  return reps;
}

/** Human-readable track record for one agent, or null when it has never been hired. */
export function repFor(agentId: string): AgentRep | null {
  return agentReputation().get(agentId) ?? null;
}

/** Compact line for the routing prompt, e.g. "94% verified over 17 missions". */
export function repSummary(agentId: string): string | null {
  const r = repFor(agentId);
  if (!r || r.missions < 2) return null;   // one data point is not a track record
  return `${Math.round(r.passRate * 100)}% verified over ${r.missions} missions`;
}

export function allReputation(): AgentRep[] {
  return [...agentReputation().values()].sort((a, b) => b.missions - a.missions);
}
