// Public mission page — trybind.xyz/m/:executionId
//
// Every finished mission becomes a shareable proof artifact: the goal, the crew, what
// each agent was paid, what passed verification, the refund, and the on-chain anchor.
// Server-rendered, self-contained (inline CSS, no external assets), and everything that
// came from a user or an agent is HTML-escaped — goals and agent output are untrusted.
import type { BindExecution } from "./types.js";

const EXPLORER = "https://www.oklink.com/xlayer/tx/";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function txLink(hash?: string): string {
  if (!hash || !hash.startsWith("0x")) return "—";
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return `<a href="${EXPLORER}${esc(hash)}" target="_blank" rel="noopener">${short}</a>`;
}

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed — every agent passed verification",
  partial: "Partial — only verified work was delivered and billed",
  failed: "Failed — no verified output; agent budget refunded",
  running: "Running — the crew is still working",
};

export function renderMissionPage(exec: BindExecution): string {
  const status = exec.status;
  const statusColor = status === "completed" ? "#4c9a5f" : status === "partial" ? "#c8a45a" : status === "running" ? "#7a8ba0" : "#b0483d";

  const steps = (exec.stepResults ?? []).map((r) => {
    const ok = r.status === "passed";
    return `<div class="step">
      <div class="step-head">
        <span class="dot" style="background:${ok ? "#4c9a5f" : "#b0483d"}"></span>
        <b>${esc(r.agentName)}</b>${r.usedFallback ? ' <span class="tag">stand-in</span>' : ""}
        <span class="right">${ok ? "verified" : esc(r.status)}</span>
      </div>
      <div class="step-meta">
        ${r.feeUsdt != null ? `paid $${esc(r.feeUsdt.toFixed(3))} · ` : ""}
        ${r.paymentTxHash?.startsWith("0x") ? `settlement ${txLink(r.paymentTxHash)}` : "no payment taken"}
        ${!ok && r.verificationResult?.detail ? `<div class="why">${esc(r.verificationResult.detail)}</div>` : ""}
        ${!ok && r.error ? `<div class="why">${esc(r.error.slice(0, 140))}</div>` : ""}
      </div>
    </div>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bind mission ${esc(exec.executionId.slice(0, 8))}</title>
<meta name="description" content="A verified multi-agent mission run by Bind on X Layer, with on-chain receipts.">
<style>
  :root { --ink:#16120b; --panel:#1d1810; --line:#c8a45a33; --gilt:#c8a45a; --ivory:#e7ddc7; --dim:#a89a7e; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--ink); color:var(--ivory); font:16px/1.65 Georgia,'Times New Roman',serif; padding:40px 20px; }
  .sheet { max-width:720px; margin:0 auto; }
  .brand { letter-spacing:.35em; font-size:13px; color:var(--gilt); text-transform:uppercase; }
  h1 { font-size:26px; margin:14px 0 4px; font-weight:600; }
  .status { display:inline-block; margin:10px 0 26px; padding:4px 12px; border:1px solid var(--line); border-radius:999px; font-size:13px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:20px 22px; margin-bottom:18px; }
  .eyebrow { font-size:11px; letter-spacing:.25em; text-transform:uppercase; color:var(--gilt); margin-bottom:10px; }
  .step { padding:12px 0; border-bottom:1px solid #c8a45a1a; } .step:last-child { border-bottom:0; }
  .step-head { display:flex; align-items:center; gap:9px; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .right { margin-left:auto; font-size:12.5px; color:var(--dim); }
  .tag { font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:0 5px; }
  .step-meta { font-size:13px; color:var(--dim); margin:4px 0 0 18px; }
  .why { font-style:italic; margin-top:2px; }
  .kv { display:flex; justify-content:space-between; gap:14px; padding:6px 0; font-size:14px; border-bottom:1px solid #c8a45a14; }
  .kv:last-child { border-bottom:0; } .kv span:first-child { color:var(--dim); }
  .deliv { white-space:pre-wrap; font-size:14.5px; }
  a { color:var(--gilt); }
  .foot { text-align:center; font-size:12.5px; color:var(--dim); margin-top:30px; }
</style></head>
<body><div class="sheet">
  <div class="brand">Bind · Mission Record</div>
  <h1>${esc(exec.goal)}</h1>
  <div class="status" style="color:${statusColor};border-color:${statusColor}55">${STATUS_LABEL[status] ?? esc(status)}</div>

  <div class="panel"><div class="eyebrow">The crew — hired, paid, inspected</div>${steps || '<div class="step-meta">The crew is being assembled…</div>'}</div>

  ${exec.finalOutput ? `<div class="panel"><div class="eyebrow">Deliverable</div><div class="deliv">${esc(exec.finalOutput)}</div></div>` : ""}

  <div class="panel"><div class="eyebrow">Receipt</div>
    <div class="kv"><span>Mission id</span><span>${esc(exec.executionId)}</span></div>
    <div class="kv"><span>Agents verified</span><span>${exec.completedSteps}/${exec.totalSteps}</span></div>
    <div class="kv"><span>Paid to agents</span><span>$${esc((exec.totalPaid ?? 0).toFixed(3))} USDT</span></div>
    ${exec.refundedUsdt ? `<div class="kv"><span>Refunded to buyer</span><span>+$${esc(exec.refundedUsdt.toFixed(3))} ${exec.refundTxHash ? "· " + txLink(exec.refundTxHash) : ""}</span></div>` : ""}
    ${exec.anchorTxHash ? `<div class="kv"><span>On-chain anchor</span><span>${txLink(exec.anchorTxHash)}</span></div>` : ""}
    <div class="kv"><span>Date</span><span>${esc((exec.completedAt ?? exec.createdAt).slice(0, 10))}</span></div>
  </div>

  <div class="foot">Run by <a href="https://trybind.xyz">Bind</a> — the general contractor for the agent economy · agent #4735 on the OKX marketplace · <a href="https://x.com/trybindX" target="_blank" rel="noopener">@trybindX</a></div>
</div></body></html>`;
}
