// Public agent track-record page. Public evidence uses commitments rather than raw buyer
// goals or verification text. Settlement references are shown only when a transaction hash
// was recorded; attempts without one remain visible but are not presented as paid proof.
import type { AgentRep } from "./reputation.js";

const EXPLORER = "https://www.oklink.com/xlayer/tx/";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function finiteNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function count(value: unknown): string {
  const n = finiteNonnegative(value);
  return Number.isSafeInteger(n) ? String(n) : "0";
}

export function scoreColor(passRate: number, missions: number): string {
  if (missions < 2) return "#6e7781";
  if (passRate >= 0.8) return "#2ea44f";
  if (passRate >= 0.5) return "#b8860b";
  return "#d1242f";
}

export function scoreLabel(rep: AgentRep | null): string {
  const missions = finiteNonnegative(rep?.missions);
  const passRate = Math.min(finiteNonnegative(rep?.passRate), 1);
  if (!rep || missions < 2) return "no track record yet";
  return `${Math.round(passRate * 100)}% verified · ${count(missions)} recorded calls`;
}

type Evidence = Array<{ at: string; evidenceId: string; serviceName?: string; status: string; feeUsdt?: number; settlementReference?: string }>;

export function renderAgentPage(agentId: string, rep: AgentRep | null, evidence: Evidence, baseUrl: string): string {
  const name = rep?.name ?? `Agent #${agentId}`;
  const missions = finiteNonnegative(rep?.missions);
  const passed = finiteNonnegative(rep?.passed);
  const fees = finiteNonnegative(rep?.feesWithSettlementReferenceUsdt);
  const passRate = Math.min(finiteNonnegative(rep?.passRate), 1);
  const color = rep ? scoreColor(passRate, missions) : "#6e7781";
  const badgeUrl = `${baseUrl}/badge/agent/${agentId}.svg`;
  const pageUrl = `${baseUrl}/a/${agentId}`;
  const embed = `<a href="${pageUrl}"><img src="${badgeUrl}" alt="Bind track record" /></a>`;

  const rows = evidence.map((e) => `<div class="step">
      <div class="step-head">
        <span class="dot" style="background:${e.status === "passed" ? "#4c9a5f" : "#b0483d"}"></span>
        <b>${esc(e.serviceName ?? "Mission step")}</b>
        <span class="right">${e.status === "passed" ? "verified" : esc(e.status)}</span>
      </div>
      <div class="step-meta">
        ${esc(String(e.at ?? "").slice(0, 10))}
        · evidence ${esc(String(e.evidenceId ?? "").slice(0, 18))}…
        ${e.feeUsdt != null ? ` · recorded $${finiteNonnegative(e.feeUsdt).toFixed(3)}` : ""}
        ${e.settlementReference ? ` · settlement reference <a href="${EXPLORER}${esc(e.settlementReference)}" target="_blank" rel="noopener">${esc(e.settlementReference.slice(0, 10))}…</a>` : " · no settlement reference"}
      </div>
    </div>`).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — Bind track record</title>
<meta name="description" content="Bind execution history. Settlement transaction links appear when available.">
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
    <div class="stat"><b>${count(missions)}</b><span>recorded calls</span></div>
    <div class="stat"><b>${count(passed)}</b><span>outputs verified</span></div>
    <div class="stat"><b>$${fees.toFixed(3)}</b><span>fees with settlement references</span></div>
    <div class="stat"><b>${Math.round(passRate * 100)}%</b><span>verified rate</span></div>
  </div>` : `<p style="color:var(--dim);margin-bottom:22px">Bind has not recorded a call to this agent yet. The record starts with its first observed call.</p>`}

  <div class="panel"><div class="eyebrow">Recorded calls</div>${rows || '<div class="step-meta">No calls recorded.</div>'}</div>

  <div class="panel"><div class="eyebrow">For this agent's builder — embed your live score</div>
    <p style="font-size:14px;margin-bottom:10px"><img src="${badgeUrl}" alt="Bind track record badge" style="vertical-align:middle"/> &nbsp;This badge reflects Bind's recorded verification history. Settlement links appear when available.</p>
    <pre>${esc(embed)}</pre>
  </div>

  <div class="foot">Records observed during Bind executions. Settlement links are shown when available · <a href="https://trybind.xyz">Bind</a> · agent #4735 on the OKX marketplace · <a href="https://x.com/trybindX" target="_blank" rel="noopener">@trybindX</a></div>
</div></body></html>`;
}
