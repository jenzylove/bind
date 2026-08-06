import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReceiptCore, canonicalJson, hashCanonical, RECEIPT_VERSION } from "./receipt.js";
import type { AgentAttempt, AgentOperationEvent, BindExecution, ExecutionResult } from "./types.js";

export interface AgentPerformance {
  agentId?: string;
  agentName: string;
  identityBasis: "agent_id" | "name_only_uncorrelated";
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
  verifiedOperations: number;
}

const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "partial"]);
const STEP_STATUSES = new Set<ExecutionResult["status"]>(["pending", "running", "passed", "failed", "skipped", "errored", "blocked"]);
const ATTEMPT_STATUSES = new Set<AgentAttempt["status"]>(["passed", "failed", "errored"]);
const PAYMENT_STATES = new Set<NonNullable<AgentAttempt["paymentState"]>>([
  "not_authorized", "authorized_ambiguous", "settlement_confirmed", "nonsettlement_confirmed",
]);
const RECEIPT_HASH = /^[0-9a-f]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid performance evidence field: ${field}`);
}

function requireCanonicalTimestamp(value: unknown, field: string): asserts value is string {
  requireString(value, field);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`invalid deterministic timestamp in performance evidence: ${field}`);
  }
}

function requireNonnegativeInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`invalid performance evidence field: ${field}`);
}

function validateAttempt(value: unknown, field: string): asserts value is AgentAttempt {
  if (!isRecord(value)) throw new Error(`invalid performance evidence field: ${field}`);
  requireString(value.agentName, `${field}.agentName`);
  if (value.agentId !== undefined) requireString(value.agentId, `${field}.agentId`);
  if (typeof value.paid !== "boolean") throw new Error(`invalid performance evidence field: ${field}.paid`);
  if (!ATTEMPT_STATUSES.has(value.status as AgentAttempt["status"])) throw new Error(`invalid performance evidence field: ${field}.status`);
  if (!PAYMENT_STATES.has(value.paymentState as NonNullable<AgentAttempt["paymentState"]>)) {
    throw new Error(`invalid performance evidence field: ${field}.paymentState`);
  }

  const paymentState = value.paymentState as AgentAttempt["paymentState"];
  if ((paymentState === "settlement_confirmed") !== value.paid) {
    throw new Error(`impossible payment dimension combination in ${field}`);
  }
  if (paymentState === "settlement_confirmed" && !TX_HASH.test(String(value.paymentTxHash ?? ""))) {
    throw new Error(`impossible payment dimension combination in ${field}: confirmed settlement lacks a transaction hash`);
  }
  if (value.paymentTxHash !== undefined && typeof value.paymentTxHash !== "string") {
    throw new Error(`invalid performance evidence field: ${field}.paymentTxHash`);
  }
}

function validateBoundTerminalExecution(value: unknown): BindExecution | null {
  if (!isRecord(value)) throw new Error("invalid performance evidence execution record");
  if (value.status === "running") return null;
  if (!TERMINAL_EXECUTION_STATUSES.has(String(value.status))) {
    throw new Error("invalid performance evidence field: status");
  }

  // Records without a v2 receipt are a truthful legacy/unbound baseline, not evidence.
  if (value.receiptVersion === undefined && value.receiptSha256 === undefined) return null;
  if (value.receiptVersion !== RECEIPT_VERSION) throw new Error("invalid performance evidence receipt version");
  if (typeof value.receiptSha256 !== "string" || !RECEIPT_HASH.test(value.receiptSha256)) {
    throw new Error("invalid performance evidence receipt hash");
  }

  requireString(value.executionId, "executionId");
  requireString(value.planId, "planId");
  if (typeof value.goal !== "string") throw new Error("invalid performance evidence field: goal");
  requireCanonicalTimestamp(value.createdAt, "createdAt");
  requireCanonicalTimestamp(value.completedAt, "completedAt");
  requireNonnegativeInteger(value.totalSteps, "totalSteps");
  requireNonnegativeInteger(value.completedSteps, "completedSteps");
  if (typeof value.totalPaid !== "number" || !Number.isFinite(value.totalPaid) || value.totalPaid < 0) {
    throw new Error("invalid performance evidence field: totalPaid");
  }
  if (!Array.isArray(value.stepResults)) throw new Error("invalid performance evidence field: stepResults");

  const seenSteps = new Set<number>();
  for (const [stepIndex, rawStep] of value.stepResults.entries()) {
    const field = `stepResults[${stepIndex}]`;
    if (!isRecord(rawStep)) throw new Error(`invalid performance evidence field: ${field}`);
    if (!Number.isInteger(rawStep.step) || (rawStep.step as number) < 1 || seenSteps.has(rawStep.step as number)) {
      throw new Error(`invalid performance evidence field: ${field}.step`);
    }
    seenSteps.add(rawStep.step as number);
    requireString(rawStep.agentName, `${field}.agentName`);
    if (!STEP_STATUSES.has(rawStep.status as ExecutionResult["status"]) || rawStep.status === "pending" || rawStep.status === "running") {
      throw new Error(`impossible terminal performance evidence field: ${field}.status`);
    }
    if (rawStep.attempts !== undefined && !Array.isArray(rawStep.attempts)) {
      throw new Error(`invalid performance evidence field: ${field}.attempts`);
    }
    if ((rawStep.attempts ?? []).length > 0) requireCanonicalTimestamp(rawStep.completedAt, `${field}.completedAt`);
    else if (rawStep.completedAt !== undefined) requireCanonicalTimestamp(rawStep.completedAt, `${field}.completedAt`);
    for (const [attemptIndex, rawAttempt] of (rawStep.attempts ?? []).entries()) {
      validateAttempt(rawAttempt, `${field}.attempts[${attemptIndex}]`);
    }
  }

  const execution = value as unknown as BindExecution;
  let localHash: string;
  try {
    localHash = hashCanonical(buildReceiptCore(execution));
  } catch (error) {
    throw new Error(`invalid performance evidence receipt: ${(error as Error).message}`);
  }
  if (localHash !== value.receiptSha256) throw new Error("performance evidence receipt hash does not match local canonical execution data");
  return execution;
}

function isTimeout(attempt: AgentAttempt): boolean {
  return /timed?\s*out|timeout|aborted|aborterror/i.test(`${attempt.error ?? ""} ${attempt.verificationDetail ?? ""}`);
}

function classifyAttempt(attempt: AgentAttempt): Pick<AgentOperationEvent, "availability" | "acceptance" | "outcome" | "verification"> {
  if (attempt.status === "passed") {
    return { availability: "online", acceptance: "accepted", outcome: "verified_completed", verification: "passed" };
  }
  if (attempt.status === "failed") {
    return { availability: "online", acceptance: "accepted", outcome: "verification_failed", verification: "failed" };
  }
  if (isTimeout(attempt)) {
    // A request timeout says nothing deterministic about network or agent availability.
    return { availability: "unknown", acceptance: "unknown", outcome: "timed_out", verification: "not_run" };
  }
  // A real HTTP response proves reachability; connection errors alone do not prove offline.
  const availability = /\bHTTP [1-5][0-9]{2}\b/i.test(attempt.error ?? "") ? "online" : "unknown";
  return { availability, acceptance: "unknown", outcome: "no_result", verification: "not_run" };
}

type EventCore = Omit<AgentOperationEvent, "eventId">;

function contentEventId(core: EventCore): string {
  return `sha256:${hashCanonical(core)}`;
}

function validateEventDimensions(event: AgentOperationEvent): void {
  if (event.schema !== "bind.agent-operation.v1" || event.evidenceSource !== "bind_execution") {
    throw new Error("invalid agent operation event schema fields");
  }
  requireCanonicalTimestamp(event.observedAt, "event.observedAt");
  requireString(event.executionId, "event.executionId");
  requireString(event.agentName, "event.agentName");
  if (event.agentId !== undefined) requireString(event.agentId, "event.agentId");
  if (event.serviceName !== undefined && typeof event.serviceName !== "string") throw new Error("invalid agent operation event schema fields");
  if (!["online", "offline", "unknown"].includes(event.availability)
    || !["accepted", "not_accepted", "unknown"].includes(event.acceptance)
    || !["verified_completed", "verification_failed", "timed_out", "no_result"].includes(event.outcome)
    || !["passed", "failed", "not_run"].includes(event.verification)
    || !PAYMENT_STATES.has(event.payment)) {
    throw new Error("invalid agent operation event schema fields");
  }
  if (!Number.isInteger(event.step) || event.step < 1 || !Number.isInteger(event.attempt) || event.attempt < 1) {
    throw new Error("invalid agent operation event schema fields");
  }
  const { eventId, ...core } = event;
  if (eventId !== contentEventId(core)) throw new Error("agent operation event ID does not commit to its content");
  const valid =
    (event.outcome === "verified_completed" && event.availability === "online" && event.acceptance === "accepted" && event.verification === "passed")
    || (event.outcome === "verification_failed" && event.availability === "online" && event.acceptance === "accepted" && event.verification === "failed")
    || (event.outcome === "timed_out" && event.availability === "unknown" && event.acceptance === "unknown" && event.verification === "not_run")
    || (event.outcome === "no_result" && (event.availability === "online" || event.availability === "unknown") && event.acceptance === "unknown" && event.verification === "not_run");
  if (!valid) throw new Error("impossible agent operation event dimension combination");
}

/** Derive immutable observations from a strict, locally receipt-hash-bound terminal execution. */
export function buildAgentOperationEvents(rawExecution: BindExecution): AgentOperationEvent[] {
  const execution = validateBoundTerminalExecution(rawExecution);
  if (!execution) return [];
  const events: AgentOperationEvent[] = [];
  for (const step of execution.stepResults) {
    for (const [index, attempt] of (step.attempts ?? []).entries()) {
      const core: EventCore = {
        schema: "bind.agent-operation.v1",
        executionId: execution.executionId,
        step: step.step,
        attempt: index + 1,
        observedAt: step.completedAt!,
        agentId: attempt.agentId,
        agentName: attempt.agentName,
        serviceName: attempt.serviceName,
        ...classifyAttempt(attempt),
        payment: attempt.paymentState!,
        evidenceSource: "bind_execution",
      };
      events.push({ ...core, eventId: contentEventId(core) });
    }
  }
  return events;
}

export function aggregateAgentPerformance(events: readonly AgentOperationEvent[]): AgentPerformance[] {
  const unique = new Map<string, AgentOperationEvent>();
  for (const event of events) {
    const prior = unique.get(event.eventId);
    if (prior) {
      if (canonicalJson(prior) !== canonicalJson(event)) throw new Error(`duplicate event ID commits conflicting content: ${event.eventId}`);
      continue;
    }
    validateEventDimensions(event);
    unique.set(event.eventId, event);
  }

  const records = new Map<string, AgentPerformance>();
  for (const event of unique.values()) {
    // Name-only observations cannot be authenticated as the same seller, even when names match.
    const key = event.agentId ? `id:${event.agentId}` : `event:${event.eventId}`;
    const record = records.get(key) ?? {
      agentId: event.agentId,
      agentName: event.agentName,
      identityBasis: event.agentId ? "agent_id" : "name_only_uncorrelated",
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
    record.verifiedPassRate = record.verifiedOperations > 0 ? record.verifiedCompleted / record.verifiedOperations : null;
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
    verifiedOperations: agents.reduce((sum, agent) => sum + agent.verifiedOperations, 0),
  };
}

/** Missing storage is an empty baseline; unreadable, corrupt, or invalid claimed evidence fails visibly. */
export function readDurableAgentOperationEvents(): AgentOperationEvent[] {
  const directory = join(process.env.BIND_DATA_DIR ?? "data/bind", "executions");
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`could not read performance evidence directory: ${(error as Error).message}`);
  }

  return files.sort().flatMap((file) => {
    if (!file.endsWith(".json")) return [];
    const path = join(directory, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`could not read performance evidence ${file}: ${(error as Error).message}`);
    }
    try {
      return buildAgentOperationEvents(raw as BindExecution);
    } catch (error) {
      throw new Error(`invalid performance evidence ${file}: ${(error as Error).message}`);
    }
  });
}
