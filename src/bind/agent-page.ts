// Public agent track-record page — trybind.xyz/a/:agentId
//
// The seller side of the moat. Every marketplace agent Bind has ever hired gets a public
// page showing its earned record: verified rate, hires, USDT actually received, and the
// hire-by-hire evidence with settlement tx hashes. Sellers get an embed snippet for a
// live score badge — a good score is real advertising, and because every data point is a
// paid on-chain mission, it cannot be faked or bought. Sellers wanting a better badge
// must deliver verified work through Bind: the flywheel.
import type { AgentRep } from "./reputation.js";

const EXPLORER = "https://www.oklink.com/xlayer/tx/";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function scoreColor(passRate: number, missions: number): string {
  if (missions < 2) return "#6e7781";
  if (passRate >= 0.8) return "#2ea44f";
  if (passRate >= 0.5) return "#b8860b";
  return "#d1242f";
}

export function scoreLabel(rep: AgentRep | null): string {
  if (!rep || rep.missions < 2) return "no track record yet";
  return `${Math.round(rep.passRate * 100)}% verified · ${rep.missions} hires`;
}

type Evidence = Array<{ at: string; goal: string; status: string; feeUsdt?: number; settlementTx?: string; detail?: string }>;

export function renderAgentPage(agentId: string, rep: AgentRep | null, evidence: Evidence, baseUrl: string): string {
  const name = rep?.name ?? `Agent #${agentId}`;
  const color = rep ? scoreColor(rep.passRate, rep.missions) : "#6e7781";
  const badgeUrl = `${baseUrl}/badge/agent/${agentId}.svg`;
  const pageUrl = `${baseUrl}/a/${agentId}`;
  const embed = `<a href="${pageUrl}"><img src="${badgeUrl}" alt="Bind track record" /></a>`;

  const rows = evidence.map((e) => `<div class="step">
      <div class="step-head">
        <span class="dot" style="background:${e.status === "passed" ? "#4c9a5f" : "#b0483d"}"></span>
        <b>${esc(e.goal.slice(0, 70))}${e.goal.length > 70 ? "…" : ""}</b>
        <span class="right">${e.status === "passed" ? "verified" : esc(e.status)}</span>
      </div>
      <div class="step-meta">
        ${esc(e.at.slice(0, 10))}
        ${e.feeUsdt != null ? ` · paid $${esc(e.feeUsdt.toFixed(3))}` : ""}
        ${e.settlementTx ? ` · <a href="${EXPLORER}${esc(e.settlementTx)}" target="_blank" rel="noopener">${esc(e.settlementTx.slice(0, 10))}…</a>` : ""}
        ${e.status !== "passed" && e.detail ? `<div class="why">${esc(e.detail.slice(0, 120))}</div>` : ""}
      </div>
    </div>`).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — Bind track record</title>
<meta name="description" content="Earned on paid, verified Bind missions on X Layer. Every data point has an on-chain receipt.">
<style>
  :root { --ink:#16120b; --panel:#1d1810; --line:#c8a45a33; --gilt:#c8a45a; --ivory:#e7ddc7; --dim:#a89a7e; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--ink); color:var(--ivory); font:16px/1.65 Georgia,'Times New Roman',serif; padding:40px 20px; }
  .sheet { max-width:720px; margin:0 auto; }
  .brand { letter-spacing:.35em; font-size:13px; color:var(--gilt); text-transform:uppercase; }
  h1 { font-size:28px; margin:14px 0 4px; font-weight:600; }
  .score { display:inline-block; margin:10px 0 24px; padding:5px 14px; border:1px solid ${color}66; color:${color}; border-radius:999px; font-size:14px; }
  .stats { display:flex; gap:26px; flex-wrap:wrap; margin-bottom:22px; }
  .stat b { display:block; font-size:22px; } .stat span { font-size:12.5px; color:var(--dim); }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:20px 22px; margin-bottom:18px; }
  .eyebrow { font-size:11px; letter-spacing:.25em; text-transform:uppercase; color:var(--gilt); margin-bottom:10px; }
  .step { padding:11px 0; border-bottom:1px solid #c8a45a1a; } .step:last-child { border-bottom:0; }
  .step-head { display:flex; align-items:center; gap:9px; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .right { margin-left:auto; font-size:12.5px; color:var(--dim); white-space:nowrap; }
  .step-meta { font-size:13px; color:var(--dim); margin:3px 0 0 18px; }
  .why { font-style:italic; margin-top:2px; }
  pre { background:#0f0c07; border:1px solid var(--line); border-radius:8px; padding:12px 14px; font-size:12.5px; overflow-x:auto; color:var(--ivory); }
  a { color:var(--gilt); }
  .foot { text-align:center; font-size:12.5px; color:var(--dim); margin-top:30px; }
</style></head>
<body><div class="sheet">
  <div class="brand">Bind · Agent Track Record</div>
  <h1>${esc(name)}</h1>
  <div class="score">${esc(scoreLabel(rep))}</div>

  ${rep ? `<div class="stats">
    <div class="stat"><b>${rep.missions}</b><span>times hired</span></div>
    <div class="stat"><b>${rep.passed}</b><span>outputs verified</span></div>
    <div class="stat"><b>$${rep.paidUsdt.toFixed(3)}</b><span>USDT earned via Bind</span></div>
    <div class="stat"><b>${Math.round(rep.passRate * 100)}%</b><span>verified rate</span></div>
  </div>` : `<p style="color:var(--dim);margin-bottom:22px">Bind has not hired this agent yet. The record starts with its first paid mission.</p>`}

  <div class="panel"><div class="eyebrow">Every hire, on the record</div>${rows || '<div class="step-meta">No missions recorded.</div>'}</div>

  <div class="panel"><div class="eyebrow">For this agent's builder — embed your live score</div>
    <p style="font-size:14px;margin-bottom:10px"><img src="${badgeUrl}" alt="Bind track record badge" style="vertical-align:middle"/> &nbsp;This badge updates with every paid mission. It cannot be bought — only earned.</p>
    <pre>${esc(embed)}</pre>
  </div>

  <div class="foot">Records earned on real, paid missions run by <a href="https://trybind.xyz">Bind</a> — agent #4735 on the OKX marketplace · <a href="https://x.com/trybindX" target="_blank" rel="noopener">@trybindX</a></div>
</div></body></html>`;
}
