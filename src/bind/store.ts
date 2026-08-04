// File-backed persistence for plans and executions. Paid paths depend on these writes being
// durable before side effects, so writes are atomic, fsynced, and fail visibly.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BindPlan, BindExecution } from "./types.js";
import { buildAgentOperationEvents } from "./agent-performance.js";

const DIR = process.env.BIND_DATA_DIR ?? "data/bind";
const UUID = /^[0-9a-fA-F-]{36}$/;

function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function persist(kind: string, id: string, obj: unknown): void {
  let serialized: string;
  try {
    const json = JSON.stringify(obj);
    if (json === undefined) throw new Error("JSON serialization returned undefined");
    serialized = `${json}\n`;
  } catch (error) {
    throw new Error(`could not serialize durable ${kind} record: ${(error as Error).message}`);
  }

  const directory = join(DIR, kind);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.json`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(path);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve original persistence error */ }
    }
    try { unlinkSync(temporary); } catch { /* temp may not exist or rename already succeeded */ }
    throw error;
  }
}

function read<T>(kind: string, id: string): T | null {
  if (!UUID.test(id)) return null;
  const path = join(DIR, kind, `${id}.json`);
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null; } catch { return null; }
}

export function savePlan(plan: BindPlan): void { persist("plans", plan.planId, plan); }
export function loadPlan(id: string): BindPlan | null { return read<BindPlan>("plans", id); }
export function saveExecution(execution: BindExecution): void {
  if (execution.status !== "running") execution.agentOperationEvents = buildAgentOperationEvents(execution);
  persist("executions", execution.executionId, execution);
}
export function loadExecution(id: string): BindExecution | null { return read<BindExecution>("executions", id); }
