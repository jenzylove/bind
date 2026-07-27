// A2A task worker — lets Bind be hired through OKX's task marketplace (the flow that
// increments SOLD), not just direct A2MCP endpoint calls.
//
// Lifecycle (per OKX task state machine): a task assigned to Bind arrives as `created` →
// Bind `apply`s (quotes a price, escrow path) → the buyer accepts (`job_accepted`, escrow
// funded, status `accepted`) → Bind runs the real mission with its own engine and
// `deliver`s the result on-chain → buyer releases → task completes → SOLD increments.
//
// This polls Bind's assigned tasks and drives each through that lifecycle. It is OFF by
// default (BIND_A2A=1 to enable) so it never takes an on-chain action unless intended.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPlan } from "./planner.js";
import { executePlan } from "./executor.js";

const run = promisify(execFile);
const BIN = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
const AGENT_ID = process.env.BIND_AGENT_ID || "4735";
const POLL_MS = 60_000;

// jobIds we've already acted on, so we never double-apply or double-deliver.
const applied = new Set<string>();
const delivered = new Set<string>();

async function oc(args: string[]): Promise<any | null> {
  try {
    const { stdout } = await run(BIN, args, { timeout: 60_000 });
    return JSON.parse(stdout);
  } catch (e) {
    const x = e as { stdout?: string };
    try { return x.stdout ? JSON.parse(x.stdout) : null; } catch { return null; }
  }
}

function why(r: any): string {
  return String(r?.error ?? r?.data?.executeErrorMsg ?? r?.msg ?? (r?.ok === true ? "ok" : "rejected")).slice(0, 140);
}

function tasksFrom(res: any): any[] {
  return res?.data?.list ?? res?.data?.tasks ?? (Array.isArray(res?.data) ? res.data : []);
}
function jobIdOf(t: any): string | null { return t?.jobId ?? t?.taskId ?? t?.id ?? null; }
function statusOf(t: any): string { return String(t?.status ?? t?.statusName ?? "").toLowerCase(); }
function goalOf(ctx: any, t: any): string {
  return String(ctx?.data?.description ?? ctx?.data?.taskDescription ?? ctx?.data?.title ?? t?.description ?? t?.title ?? "").trim();
}

function assignedToUs(t: any): boolean {
  const ids = [t?.aspAgentId, t?.providerAgentId, t?.provider?.agentId, t?.aspId].map((x) => String(x ?? ""));
  return ids.includes(AGENT_ID);
}

async function processTask(t: any): Promise<void> {
  const jobId = jobIdOf(t);
  if (!jobId) return;
  const status = statusOf(t);

  // Apply ONLY to a task freshly assigned to us and still in `created` (never applied to).
  if (status === "created" && assignedToUs(t) && !applied.has(jobId)) {
    applied.add(jobId);
    const amount = String(t.budget ?? t.tokenAmount ?? t.amount ?? "0.5");
    const r = await oc(["agent", "apply", jobId, "--token-amount", amount, "--token-symbol", "USDT", "--agent-id", AGENT_ID]);
    console.log(`[a2a] apply ${jobId} @ ${amount} -> ${why(r)}`);
    return;
  }

  // Deliver ONLY when we are the CONFIRMED accepted provider on a funded task. This gate is
  // what protects the wallet: we never run a paid mission for a task we haven't won.
  if (status === "accepted" && assignedToUs(t) && !delivered.has(jobId)) {
    delivered.add(jobId); // claim before work so a retry can't double-spend
    const ctx = await oc(["agent", "common", "context", jobId, "--role", "asp", "--agent-id", AGENT_ID]);
    if (ctx && ctx.ok === false) { console.warn(`[a2a] ${jobId} context failed: ${why(ctx)}`); delivered.delete(jobId); return; }
    const goal = goalOf(ctx, t);
    if (!goal) { console.warn(`[a2a] ${jobId} accepted but no goal text; skipping`); return; }

    console.log(`[a2a] ${jobId} won — running mission: "${goal.slice(0, 60)}"`);
    let deliverable: string;
    try {
      const plan = await createPlan({ goal });
      if (!plan.steps.length) {
        deliverable = "Bind has no marketplace agent that can genuinely deliver this: " + (plan.note ?? "no compatible specialist found.");
      } else {
        const exec = await executePlan(plan);
        deliverable = exec.finalOutput || "No agent output passed verification, so no reliable deliverable could be produced.";
      }
    } catch (e) {
      deliverable = "Bind could not complete this task: " + (e as Error).message.slice(0, 160);
    }
    const r = await oc(["agent", "deliver", jobId, "--deliverable-text", deliverable.slice(0, 4000), "--agent-id", AGENT_ID]);
    console.log(`[a2a] deliver ${jobId} -> ${why(r)}`);
  }
}

async function pollOnce(): Promise<void> {
  const res = await oc(["agent", "active-tasks", "--role", "asp"]);
  const tasks = tasksFrom(res);
  if (!tasks.length) return;
  for (const t of tasks) {
    try { await processTask(t); } catch (e) { console.warn(`[a2a] task error:`, (e as Error).message); }
  }
}

export function scheduleA2AWorker(): void {
  if (process.env.BIND_A2A !== "1") {
    console.log("[a2a] task worker disabled (set BIND_A2A=1 to enable)");
    return;
  }
  console.log("[a2a] task worker enabled — polling assigned tasks");
  setTimeout(() => { void pollOnce(); }, 15_000);
  setInterval(() => { void pollOnce().catch(() => {}); }, POLL_MS);
}
