// Auto-grow the crew: a nightly, budget-capped payability probe.
//
// The marketplace changes under us — new agents list every day, and each one is useless
// to Bind until a real signed payment has proven it settles AND returns data. That test
// is scripts/probe-payability.mjs (the same battle-tested script that built the current
// allowlist, with its own $0.12 spend cap, $0.02 fee ceiling, and an already-probed set
// so money is never spent re-confirming a known verdict). This module just runs it on a
// schedule; the planner re-reads the allowlist within minutes, so a new payable agent is
// hireable without a redeploy.
//
// Safety rails: at most one run per 22h (persisted on the volume, so redeploys don't
// stack runs), and BIND_AUTOPROBE=0 turns the whole thing off.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.BIND_DATA_DIR ?? "data";
const LAST_RUN_FILE = join(DATA_DIR, "autoprobe-last.json");
const MIN_GAP_MS = 22 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 12 * 60 * 1000;

function lastRunAt(): number {
  try { return JSON.parse(readFileSync(LAST_RUN_FILE, "utf8")).at ?? 0; } catch { return 0; }
}
function recordRun(summary: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LAST_RUN_FILE, JSON.stringify({ at: Date.now(), summary }));
  } catch { /* volume unavailable — worst case we re-run next boot */ }
}

let running = false;

function runProbe(): void {
  if (running) return;
  running = true;
  console.log("[autoprobe] starting nightly payability probe");
  // Claim the slot up front so a crash can't cause a rapid re-run loop.
  recordRun("started");

  const child = spawn(process.execPath, ["scripts/probe-payability.mjs"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, PROBE_TIMEOUT_MS);
  child.on("close", (code) => {
    clearTimeout(killer);
    running = false;
    const summary = tail.split("\n").filter((l) => l.includes("DONE") || l.includes("data-usable")).join(" | ") || `exit ${code}`;
    recordRun(summary);
    console.log(`[autoprobe] finished (exit ${code}): ${summary.slice(0, 300)}`);
  });
  child.on("error", (e) => {
    clearTimeout(killer);
    running = false;
    recordRun(`spawn failed: ${e.message}`);
    console.warn(`[autoprobe] could not run probe: ${e.message}`);
  });
}

export function scheduleAutoprobe(): void {
  if (process.env.BIND_AUTOPROBE === "0") {
    console.log("[autoprobe] disabled via BIND_AUTOPROBE=0");
    return;
  }
  const tick = () => { if (Date.now() - lastRunAt() >= MIN_GAP_MS) runProbe(); };
  // First check a few minutes after boot (let the service settle), then hourly.
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, CHECK_EVERY_MS);
}
