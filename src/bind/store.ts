// File-backed persistence for plans and executions. The in-memory Maps in routes.ts
// stay as a fast cache, but a plan created just before a container restart is no longer
// lost: /execute and /status fall back to disk. On a deploy with a persistent volume
// mounted at the data dir, these also survive redeploys.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BindPlan, BindExecution } from "./types.js";

const DIR = process.env.BIND_DATA_DIR ?? "data/bind";
const UUID = /^[0-9a-fA-F-]{36}$/;

function persist(kind: string, id: string, obj: unknown): void {
  try {
    mkdirSync(join(DIR, kind), { recursive: true });
    writeFileSync(join(DIR, kind, `${id}.json`), JSON.stringify(obj));
  } catch { /* disk unavailable — memory cache still serves the common path */ }
}
function read<T>(kind: string, id: string): T | null {
  if (!UUID.test(id)) return null;
  const p = join(DIR, kind, `${id}.json`);
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null; } catch { return null; }
}

export function savePlan(p: BindPlan): void { persist("plans", p.planId, p); }
export function loadPlan(id: string): BindPlan | null { return read<BindPlan>("plans", id); }
export function saveExecution(e: BindExecution): void { persist("executions", e.executionId, e); }
export function loadExecution(id: string): BindExecution | null { return read<BindExecution>("executions", id); }
