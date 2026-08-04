import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAttempt, AgentOperationEvent, BindExecution } from "./types.js";

const MIN_VERIFIED_OPERATIONS_FOR_EXCLUSION = 3;
const EXCLUDE_BELOW_VERIFIED_PASS_RATE = 0.34;

export interface AgentPerformance {
  agentId?: string;
  agentName: string;
  testedOperations: number;
  onlineObservations: number;
  offlineObservations: number;
  availabilityUnknown: number;
  verifiedCompleted: number;
  verificationFailed: number;
  timedOut: number;
  noResult: number;
  verifiedOperations: number;
  /** Null means there is no verified denominator, not a zero-percent rating. */
  verifiedPassRate: number | null;
  routingEligibility: "eligible" | "excluded";
  routingReason?: string;
  latestAvailability: AgentOperationEvent["availability"];
  latestObservedAt: string;
}

export interface AgentPerformanceSummary {
  agentsTested: number;
  online: number;
  offline: number;
  availabilityUnknown: number;
  completed: number;
  failedVerification: number;
  timedOut: number;
  noResult: number;
  removedFromRouting: number;
  verifiedOperations: number;
}

function eventId(executionId: string, step: number, attempt: number): string {
  return `sha256:${createHash("sha256").update(`bind.agent-operation.v1\0${executionId}\0${step}\0${attempt}`).digest("hex")}`;
}

function isTimeout(attempt: AgentAttempt): boolean {
  return /timed?\s*out|timeout|aborted|aborterror/i.test(`${attempt.error ?? ""} ${attempt.verificationDetail ?? ""}`);
}

function isExplicitlyOffline(attempt: AgentAttempt): boolean {
  return isTimeout(attempt)
    || /HTTP 0\b|fetch failed|ECONN(?:REFUSED|RESET)|ENOTFOUND|network error|socket hang up/i.test(`${attempt.error ?? ""} ${attempt.verificationDetail ?? ""}`);
}

function classifyAttempt(attempt: AgentAttempt): Pick<AgentOperationEvent, "availability" | "acceptance" | "outcome" | "verification"> {
  if (attempt.status === "passed") {
    return { availability: "online", acceptance: "accepted", outcome: "verified_completed", verification: "passed" };
  }
  if (attempt.status === "failed") {
    return { availability: "online", acceptance: "accepted", outcome: "verification_failed", verification: "failed" };
  }
  if (isTimeout(attempt)) {
    return { availability: "offline", acceptance: "unknown", outcome: "timed_out", verification: "not_run" };
  }
  return {
    availability: isExplicitlyOffline(attempt) ? "offline" : "unknown",
    acceptance: "unknown",
    outcome: "no_result",
    verification: "not_run",
  };
}

/** Pure projection used by the durable store. Running executions intentionally yield none. */
export function buildAgentOperationEvents(execution: BindExecution): AgentOperationEvent[] {
  if (execution.status === "running") return [];
  const events: AgentOperationEvent[] = [];
  for (const step of execution.stepResults ?? []) {
    for (const [index, attempt] of (step.attempts ?? []).entries()) {
      const classification = classifyAttempt(attempt);
      events.push({
        schema: "bind.agent-operation.v1",
        eventId: eventId(execution.executionId, step.step, index + 1),
        executionId: execution.executionId,
        step: step.step,
        attempt: index + 1,
        observedAt: step.completedAt ?? execution.completedAt ?? execution.createdAt,
        agentId: attempt.agentId,
        agentName: attempt.agentName,
        serviceName: attempt.serviceName,
        ...classification,
        payment: attempt.paymentState ?? "not_authorized",
        evidenceSource: "bind_execution",
      });
    }
  }
  return events;
}

function agentKey(event: AgentOperationEvent): string {
  return event.agentId ? `id:${event.agentId}` : `name:${event.agentName}`;
}

export function aggregateAgentPerformance(events: readonly AgentOperationEvent[]): AgentPerformance[] {
  const records = new Map<string, AgentPerformance>();
  for (const event of events) {
    if (event.schema !== "bind.agent-operation.v1" || event.evidenceSource !== "bind_execution") continue;
    const key = agentKey(event);
    const record = records.get(key) ?? {
      agentId: event.agentId,
      agentName: event.agentName,
      testedOperations: 0,
      onlineObservations: 0,
      offlineObservations: 0,
      availabilityUnknown: 0,
      verifiedCompleted: 0,
      verificationFailed: 0,
      timedOut: 0,
      noResult: 0,
      verifiedOperations: 0,
      verifiedPassRate: null,
      routingEligibility: "eligible",
      latestAvailability: event.availability,
      latestObservedAt: event.observedAt,
    } satisfies AgentPerformance;
    record.testedOperations += 1;
    if (event.availability === "online") record.onlineObservations += 1;
    else if (event.availability === "offline") record.offlineObservations += 1;
    else record.availabilityUnknown += 1;
    if (event.outcome === "verified_completed") record.verifiedCompleted += 1;
    else if (event.outcome === "verification_failed") record.verificationFailed += 1;
    else if (event.outcome === "timed_out") record.timedOut += 1;
    else record.noResult += 1;
    if (event.observedAt >= record.latestObservedAt) {
      record.latestObservedAt = event.observedAt;
      record.latestAvailability = event.availability;
    }
    records.set(key, record);
  }

  for (const record of records.values()) {
    record.verifiedOperations = record.verifiedCompleted + record.verificationFailed;
    record.verifiedPassRate = record.verifiedOperations > 0
      ? record.verifiedCompleted / record.verifiedOperations
      : null;
    if (record.verifiedOperations >= MIN_VERIFIED_OPERATIONS_FOR_EXCLUSION
      && record.verifiedPassRate !== null
      && record.verifiedPassRate < EXCLUDE_BELOW_VERIFIED_PASS_RATE) {
      record.routingEligibility = "excluded";
      record.routingReason = `removed from Bind routing after ${record.verifiedOperations} verified operations; verified pass rate ${Math.round(record.verifiedPassRate * 100)}%`;
    }
  }
  return [...records.values()].sort((a, b) => b.testedOperations - a.testedOperations || a.agentName.localeCompare(b.agentName));
}

export function summarizeAgentPerformance(events: readonly AgentOperationEvent[]): AgentPerformanceSummary {
  const agents = aggregateAgentPerformance(events);
  return {
    agentsTested: agents.length,
    online: agents.filter((agent) => agent.latestAvailability === "online").length,
    offline: agents.filter((agent) => agent.latestAvailability === "offline").length,
    availabilityUnknown: agents.filter((agent) => agent.latestAvailability === "unknown").length,
    completed: agents.reduce((sum, agent) => sum + agent.verifiedCompleted, 0),
    failedVerification: agents.reduce((sum, agent) => sum + agent.verificationFailed, 0),
    timedOut: agents.reduce((sum, agent) => sum + agent.timedOut, 0),
    noResult: agents.reduce((sum, agent) => sum + agent.noResult, 0),
    removedFromRouting: agents.filter((agent) => agent.routingEligibility === "excluded").length,
    verifiedOperations: agents.reduce((sum, agent) => sum + agent.verifiedOperations, 0),
  };
}

/** Reads only explicit v1 events. Legacy execution records are not guessed into evidence. */
export function readDurableAgentOperationEvents(): AgentOperationEvent[] {
  try {
    const directory = join(process.env.BIND_DATA_DIR ?? "data/bind", "executions");
    return readdirSync(directory).flatMap((file) => {
      if (!file.endsWith(".json")) return [];
      try {
        const execution = JSON.parse(readFileSync(join(directory, file), "utf8")) as BindExecution;
        return Array.isArray(execution.agentOperationEvents) ? execution.agentOperationEvents : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function durableAgentPerformance(): AgentPerformance[] {
  return aggregateAgentPerformance(readDurableAgentOperationEvents());
}

export function isRemovedFromRouting(agentId: string, name?: string): boolean {
  return durableAgentPerformance().some((agent) =>
    agent.routingEligibility === "excluded" && (agent.agentId === agentId || (!agent.agentId && agent.agentName === name)),
  );
}
