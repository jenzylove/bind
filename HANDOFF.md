# Bind — build handoff / context

Portable context for continuing this build in **any** tool (Claude, Codex, Hermes, a teammate).
The code lives in git; this file carries the *why*, the *state*, and the *gotchas* that the
code alone doesn't show. Read this first.

## What Bind is
The general contractor for the agent economy. A user describes a goal; Bind discovers a
vetted crew of on-chain agents on the OKX marketplace, **pays each via x402 on X Layer**,
**verifies** every output (drops failures), and returns **one synthesized deliverable** plus
an **on-chain receipt** for every payment. The moat is trust/vetting/verification, not
convenience — see positioning below.

## Live surfaces
- App + API: **https://www.trybind.xyz** (also `bind-production-f593.up.railway.app` — the URL
  registered with OKX; do NOT change it). Root serves the app to browsers, JSON to machines.
- OKX marketplace: registered **ASP agent #4735** ("listing under review", passed AI review).
- Repo: `github.com/jenzylove/bind` (branch `master`). Hosting: **Railway** (Nixpacks).

## Architecture (Express/TypeScript, `src/`)
- `server.ts` — routes, CORS, per-IP rate limit on /bind/plan + /bind/execute.
- `bind/planner.ts` — goal → plan. Live marketplace search + **AI routing** (`select.ts`,
  Claude) picks a complementary crew from the payable set; guardrails cap price + exclude
  action agents. Pins the **verified working endpoint** per agent (see gotcha #2). Adds the
  platform fee (2% + $0.03).
- `bind/executor.ts` — pays each agent via x402 (TEE wallet), verifies (`verify.ts`),
  anchors a receipt (`receipt.ts` → burn-address calldata). `getParams()` = hardcoded params
  for known agents; unknown → `agent-infer.ts` (LLM param inference).
- `bind/pay-verify.ts` — **buyer-pays gate**: verifies the user's USDT payment on X Layer
  (via RPC) before spending. `/bind/execute` returns 402 without a valid `paymentTxHash`
  unless `BIND_ALLOW_FREE=1`.
- `bind/synthesize.ts` — Claude turns verified outputs into one readable deliverable.
- `bind/store.ts` — plans/executions persisted to a Railway volume (`BIND_DATA_DIR=/data`).
- `data/payable-agents.json` — the tested agent crew (see below).

## The agent crew (the hard-won asset)
The OKX marketplace has ~127 A2MCP agents / 481 services, but most reject payment or return
no usable data. `data/payable-agents.json` is the **tested allowlist**: `payableIds` +
`endpoints` (the exact working endpoint per agent) = **14 data-confirmed** agents the planner
routes to. `needsParams` = agents that settle payment but need per-agent param work.
To grow the crew, re-run in order (they cost small real USDT from the agentic wallet):
1. `node scripts/deep-probe.mjs` — FREE map of every service's payment surface.
2. `node scripts/settle-test.mjs` — pays signable agents, finds which settle + return data.
3. `node scripts/grow-crew.mjs` — reads settlement errors to learn required params, retests.
4. `node scripts/generate-payable.mjs` — rebuilds payable-agents.json.

## Gotchas (these cost hours — heed them)
1. **Use the CLI's `header_name`**, don't guess the payment header. `onchainos payment pay
   --payload <b64>` returns `{authorization_header, header_name, scheme, wallet}` — send
   `authorization_header` under `header_name`.
2. **The working service is often NOT the cheapest** — a cheaper sibling is frequently a dead
   404. Always pin the endpoint that the settlement test confirmed.
3. **Deploy source drift**: `railway up` deploys LOCAL code, but a Railway *variable change*
   redeploys from the connected **GitHub** repo. Always `git push origin master` before/with
   any deploy, or a var change reverts prod to stale code.
4. **x402 overcharge**: an agent's live 402 can demand far more than its listed fee. The
   executor refuses payments above the quote (see `MAX_ABS_PER_CALL_USDT`). Keep that guard.
5. Anchoring needs `ONCHAINOS_BIN=/root/.local/bin/onchainos` on Railway.

## Env vars (VALUES are NOT in the repo — set on Railway / local `.env`)
`ONCHAINOS_BIN`, `PAY_TO_ADDRESS` (agentic wallet 0xf227…), `USDT_ASSET`, `ANTHROPIC_API_KEY`,
`BIND_DATA_DIR=/data`, `BIND_ALLOW_FREE` (0 = payment required for launch), OKX creds
(`OKX_API_KEY` + secret + passphrase for `onchainos` login).

## What can't travel in a file
The payment flow runs through the **OKX agentic wallet + `onchainos` CLI**, tied to the OKX
account and its TEE wallet (address 0xf227…). A new machine/agent must: install `onchainos`,
log in to the OKX account, and have the agentic wallet funded with USD₮0 on X Layer. Without
that, planning/UI work but paid agent calls won't.

## Positioning (don't drift back to "wrapper")
Bind is the **trust/accountability layer** the marketplace lacks: it knows which agents
actually deliver (we tested them), verifies outputs, and issues on-chain receipts. Orchestration
is the wedge; the vetting + verification + reputation data is the moat.

## State / what's next
Done: buyer-pays x402 + on-chain verification, verification gate + anchored receipts, AI
routing across the marketplace, synthesized deliverables, 14-agent crew, night-ledger UI +
landing/app split, platform fee, X branding. Deadline: OKX AI Genesis, **July 17 2026**.
Next: grow the crew via per-agent params (`needsParams`); surface per-agent reputation from
execution history; social launch (thread + demo) before the 17th.
