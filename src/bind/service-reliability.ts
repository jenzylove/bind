import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAttempt, BindExecution, ExecutionResult } from "./types.js";

const DIR = process.env.BIND_DATA_DIR ?? "data/bind";
const CACHE_TTL_MS = 60_000;

export interface ServiceReliability {
  key: string;
  attempts: number;
  passed: number;
  failed: number;
  paidFailed: number;
  passRate: number;
  lastFailure?: string;
}

let cache: { at: number; stats: Map<string, ServiceReliability> } | null = null;

export function serviceKey(agentId?: string, serviceName?: string, endpoint?: string): string {
  return `${agentId || ""}|${serviceName || ""}|${endpoint || ""}`;
}

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
    return [];
  }
}

function legacyAttempt(step: ExecutionResult): AgentAttempt {
  return {
    agentId: step.agentId,
    agentName: step.agentName,
    serviceName: step.serviceName,
    feeUsdt: step.feeUsdt,
    paid: Boolean(step.paymentTxHash?.startsWith("0x")),
    status: step.status === "passed" ? "passed" : step.status === "failed" ? "failed" : "errored",
    paymentTxHash: step.paymentTxHash,
    input: step.input,
    verificationDetail: step.verificationResult?.detail ?? step.error,
    error: step.error,
  };
}

export function serviceReliability(): Map<string, ServiceReliability> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.stats;

  const stats = new Map<string, ServiceReliability>();
  for (const exec of readExecutions()) {
    for (const step of exec.stepResults ?? []) {
      const attempts = step.attempts?.length ? step.attempts : [legacyAttempt(step)];
      for (const attempt of attempts) {
        if (!attempt.agentId && !attempt.serviceName && !attempt.endpoint) continue;
        const key = serviceKey(attempt.agentId, attempt.serviceName, attempt.endpoint);
        const rec = stats.get(key) ?? { key, attempts: 0, passed: 0, failed: 0, paidFailed: 0, passRate: 0 };
        rec.attempts += 1;
        if (attempt.status === "passed") rec.passed += 1;
        else {
          rec.failed += 1;
          rec.lastFailure = attempt.verificationDetail || attempt.error;
          if (attempt.paid) rec.paidFailed += 1;
        }
        stats.set(key, rec);
      }
    }
  }
  for (const rec of stats.values()) rec.passRate = rec.attempts ? rec.passed / rec.attempts : 0;
  cache = { at: now, stats };
  return stats;
}

export function serviceReliabilityFor(agentId?: string, serviceName?: string, endpoint?: string): ServiceReliability | null {
  const stats = serviceReliability();
  return stats.get(serviceKey(agentId, serviceName, endpoint))
    ?? stats.get(serviceKey(agentId, serviceName, undefined))
    ?? null;
}

export function serviceReliabilitySummary(agentId?: string, serviceName?: string, endpoint?: string): string | null {
  const rec = serviceReliabilityFor(agentId, serviceName, endpoint);
  if (!rec || rec.attempts < 1) return null;
  const rate = `${Math.round(rec.passRate * 100)}% verified over ${rec.attempts} service attempt${rec.attempts === 1 ? "" : "s"}`;
  return rec.lastFailure ? `${rate}; last failure: ${rec.lastFailure.slice(0, 80)}` : rate;
}

export function serviceReliabilityPenalty(agentId?: string, serviceName?: string, endpoint?: string): number {
  const rec = serviceReliabilityFor(agentId, serviceName, endpoint);
  if (!rec) return 0;
  if (rec.attempts >= 2 && rec.passRate === 0 && rec.paidFailed > 0) return 40;
  if (rec.attempts >= 3 && rec.passRate < 0.34) return 25;
  if (rec.paidFailed > 0 && rec.passed === 0) return 12;
  return 0;
}
