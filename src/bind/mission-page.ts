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

function safeCount(value: unknown): string {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : "0";
}

function safeMoney(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toFixed(3) : "0.000";
}

function txLink(hash?: string): string {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return "—";
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return `<a href="${EXPLORER}${esc(hash)}" target="_blank" rel="noopener">${short}</a>`;
}

function refundRow(exec: BindExecution): string {
  const recordedDue = exec.refundAmountDueUsdt ?? exec.refundAmountSubmittedUsdt ?? exec.refundedUsdt ?? 0;
  const due = typeof recordedDue === "number" && Number.isFinite(recordedDue) && recordedDue > 0 ? recordedDue : 0;
  if (due <= 0) return "";
  const validTx = !!(exec.refundTxHash && /^0x[0-9a-fA-F]{64}$/.test(exec.refundTxHash));
  if (exec.refundState === "confirmed" && validTx && (exec.refundAmountConfirmedUsdt ?? 0) > 0) {
    return `<div class="kv"><span>Refund confirmed</span><span>+$${safeMoney(exec.refundAmountConfirmedUsdt!)} · ${txLink(exec.refundTxHash)}</span></div>`;
  }
  if ((exec.refundState === "submitted" || exec.refundState == null) && validTx) {
    const submitted = exec.refundAmountSubmittedUsdt ?? exec.refundedUsdt ?? due;
    return `<div class="kv"><span>Refund submitted</span><span>+$${safeMoney(submitted)} · ${txLink(exec.refundTxHash)}</span></div>`;
  }
  const state = exec.refundState === "below_threshold"
    ? "Refund due below threshold"
    : exec.refundState === "failed"
      ? "Refund owed — submission failed"
      : exec.refundState === "confirmation_failed"
        ? "Refund owed — confirmation failed"
        : "Refund owed — evidence unconfirmed";
  return `<div class="kv"><span>${state}</span><span>$${esc(due.toFixed(3))}${exec.refundReason ? ` · ${esc(exec.refundReason)}` : ""}</span></div>`;
}

function statusLabel(exec: BindExecution): string {
  if (exec.status === "completed") return "Completed — every agent passed verification";
  if (exec.status === "partial") return "Partial — verified outputs were delivered; payment and refund evidence follows";
  if (exec.status === "running") return "Running — the crew is still working";
  if (exec.refundState === "submitted" && exec.refundTxHash && /^0x[0-9a-fA-F]{64}$/.test(exec.refundTxHash)) {
    return "Failed — no verified output; refund submitted";
  }
  if ((exec.refundAmountDueUsdt ?? 0) > 0) return "Failed — no verified output; refund remains owed";
  return "Failed — no verified output";
}

export function renderMissionPage(exec: BindExecution): string {
  const label = statusLabel(exec);
  const status = exec.status;
  const statusColor = status === "completed" ? "#4c9a5f" : status === "partial" ? "#c8a45a" : status === "running" ? "#7a8ba0" : "#b0483d";

  const steps = (exec.stepResults ?? []).map((r) => {
    const ok = r.status === "passed";
    return `<div class="step">
      <div class="step-head">
        <span class="dot" style="background:${ok ? "#4c9a5f" : "#b0483d"}"></span>
        <b>${esc(r.serviceName || r.agentName)}</b>${r.usedFallback ? ' <span class="tag">stand-in</span>' : ""}
        <span class="right">${ok ? "verified" : esc(r.status)}</span>
      </div>
      <div class="step-meta">
        ${r.feeUsdt != null ? `recorded $${safeMoney(r.feeUsdt)} · ` : ""}
        ${r.paymentTxHash && /^0x[0-9a-fA-F]{64}$/.test(r.paymentTxHash)
          ? `settlement ${txLink(r.paymentTxHash)}`
          : r.paymentTxHash === "no_payment_needed"
            ? "no payment required"
            : r.paymentTxHash === "settlement_unconfirmed"
              ? "settlement unconfirmed"
              : "no settlement evidence"}
        ${!ok && r.verificationResult?.detail ? `<div class="why">${esc(r.verificationResult.detail)}</div>` : ""}
        ${!ok && r.error ? `<div class="why">${esc(r.error.slice(0, 140))}</div>` : ""}
      </div>
    </div>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bind mission ${esc(String(exec.executionId ?? "").slice(0, 8))}</title>
<meta name="description" content="A multi-agent mission record from Bind, with canonical integrity commitments and recorded transaction references.">
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
  <div class="status" style="color:${statusColor};border-color:${statusColor}55">${esc(label)}</div>

  <div class="panel"><div class="eyebrow">The crew · called, inspected, recorded</div>${steps || '<div class="step-meta">The crew is being assembled…</div>'}</div>

  ${exec.finalOutput ? `<div class="panel"><div class="eyebrow">Deliverable</div><div class="deliv">${esc(exec.finalOutput)}</div></div>` : ""}

  <div class="panel"><div class="eyebrow">Receipt</div>
    <div class="kv"><span>Mission id</span><span>${esc(exec.executionId)}</span></div>
    <div class="kv"><span>Agents verified</span><span>${safeCount(exec.completedSteps)}/${safeCount(exec.totalSteps)}</span></div>
    <div class="kv"><span>Recorded agent fees</span><span>$${safeMoney(exec.totalPaid)} USDT</span></div>
    ${refundRow(exec)}
    ${exec.anchorTxHash ? `<div class="kv"><span>Anchor submission reference</span><span>${txLink(exec.anchorTxHash)}</span></div>` : ""}
    ${exec.receiptSha256 ? `<div class="kv"><span>Receipt SHA-256</span><span style="overflow-wrap:anywhere">${esc(exec.receiptSha256)}</span></div>
    <div class="kv"><span>Receipt proof</span><span><a href="/bind/receipt/${encodeURIComponent(exec.executionId)}" target="_blank" rel="noopener">canonical JSON and local hash check</a></span></div>` : ""}
    <div class="kv"><span>Date</span><span>${esc(String(exec.completedAt ?? exec.createdAt ?? "").slice(0, 10))}</span></div>
  </div>

  <div class="foot">Run by <a href="https://trybind.xyz">Bind</a> · verified agent crews, one deliverable · agent #4735 on the OKX marketplace · <a href="https://x.com/trybindX" target="_blank" rel="noopener">@trybindX</a></div>
</div></body></html>`;
}
