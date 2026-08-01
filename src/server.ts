// Bind — the orchestrator for the agent economy
// Built on x402 payment, inter-step verification, and on-chain anchoring
import express from "express";
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { config, isConfiguredForPayment } from "./config.js";
import { bindRouter } from "./bind/routes.js";
import { renderBadge, renderScoreBadge } from "./badge.js";
import { loadExecution } from "./bind/store.js";
import { warmCatalog } from "./bind/marketplace.js";
import { scheduleAutoprobe } from "./bind/autoprobe.js";
import { scheduleA2AWorker } from "./bind/a2a-worker.js";
import { renderAgentPage, scoreColor, scoreLabel } from "./bind/agent-page.js";
import { agentEvidence } from "./bind/reputation.js";
import { reconcilePaymentClaimsOnStartup } from "./bind/payment-reconciliation.js";
import { refundExactBaseUnits } from "./bind/refund.js";
import { recoverStalePaymentClaimLocks } from "./bind/payment-claims.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR));

// CORS — allow frontend on Vercel to call this API
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PAYMENT, PAYMENT-SIGNATURE");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

const SERVICE = {
  name: "Bind",
  tagline: "Your entry to the agent economy.",
  version: "0.1.0",
};

app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.accepts(["html", "json"]) === "html" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "private, no-store");
  }
  next();
});

// Serve the web demo UI. /mission is the hard-pinned product and share target.
app.get(["/app", "/bind/app", "/mission"], (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "bind.html"));
});

// Design preview (work in progress)
app.get("/bind/preview", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "bind-preview.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...SERVICE, paymentConfigured: isConfiguredForPayment() });
});

app.get("/", (req, res) => {
  // A browser sharing/opening this link should land on the actual product, not raw JSON.
  // Machine clients (OKX discovery, curl, other agents) send Accept: application/json (or
  // */*) and still get the service descriptor — this doesn't change the A2MCP contract.
  if (req.accepts(["html", "json"]) === "html") {
    res.sendFile(join(PUBLIC_DIR, "bind.html"));
    return;
  }
  res.json({
    ...SERVICE,
    network: config.network,
    tools: [
      {
        name: "bind_plan",
        price: config.prices.bind_plan,
        unit: "USDT base units",
        summary: "Describe a goal and get a multi-agent plan with a flat price. Humans can get the same plan free at the web app.",
        status: "live",
      },
      {
        name: "bind_execute",
        price: config.prices.bind_execute,
        unit: "USDT base units",
        summary: "Execute a plan: pays each agent on X Layer, verifies each output, returns one deliverable + on-chain receipt. Unspent agent budget is refunded to the buyer.",
        status: "live",
      },
    ],
    tryItYourself: `${config.publicBaseUrl}/bind/app`,
  });
});

// Lightweight per-IP rate limit on the AI-backed endpoints. /bind/plan calls Claude on
// every request (agent routing) and /bind/execute moves money — both are public, so this
// is a cheap guard against a script running up Anthropic costs or hammering the wallet.
const hits = new Map<string, { count: number; resetAt: number }>();
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX = 40;
app.use(["/bind/plan", "/bind/execute", "/bind/quote", "/bind/mission"], (req, res, next) => {
  const ip = (req.headers["x-forwarded-for"] as string || req.ip || "unknown").split(",")[0].trim();
  const now = Date.now();
  // Keep the map bounded: drop expired windows once it grows past a sane size.
  if (hits.size > 10_000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
  } else if (rec.count >= RL_MAX) {
    res.status(429).json({ error: "rate_limited", message: "Too many requests — please wait a few minutes." });
    return;
  } else {
    rec.count++;
  }
  next();
});

// Bind — orchestrator routes
app.use("/bind", bindRouter);

// Status badge for Bind executions, reflects the recorded execution outcome.
app.get("/badge/:executionId.svg", (req, res) => {
  const exec = loadExecution(req.params.executionId);
  const state =
    !exec ? "unknown"
    : exec.status === "completed" ? "pass"
    : exec.status === "partial" ? "partial"
    : exec.status === "running" ? "running"
    : "fail";
  res.type("image/svg+xml").set("Cache-Control", "private, no-store").send(renderBadge(state));
});

// Seller moat: a live, embeddable score badge for any marketplace agent, earned on paid
// verified missions. Sellers embed it; a good score is advertising they can't buy.
app.get("/badge/agent/:agentId.svg", (req, res) => {
  const id = String(req.params.agentId).replace(/[^0-9]/g, "");
  const { rep } = agentEvidence(id);
  const color = rep ? scoreColor(rep.passRate, rep.missions) : "#6e7781";
  res.type("image/svg+xml").set("Cache-Control", "max-age=300").send(renderScoreBadge(scoreLabel(rep), color));
});

// Public agent track-record page, with the embed snippet for the agent's builder.
app.get("/a/:agentId", (req, res) => {
  const id = String(req.params.agentId).replace(/[^0-9]/g, "");
  if (!id) { res.status(404).send("unknown agent"); return; }
  const { rep, evidence } = agentEvidence(id);
  res.type("html").send(renderAgentPage(id, rep, evidence, config.publicBaseUrl));
});

// Persist onchainos's session dir (~/.onchainos) onto the Railway volume, so a wallet we
// log in ONCE survives redeploys and restarts (the root cause of the server running with
// no logged-in wallet: an ephemeral container filesystem loses the session every deploy).
function persistOnchainosSession(): void {
  const home = process.env.HOME || process.env.USERPROFILE || "/root";
  const ocDir = join(home, ".onchainos");
  const persistDir = join(process.env.BIND_DATA_DIR || "/data", "onchainos-home");
  mkdirSync(dirname(persistDir), { recursive: true, mode: 0o700 });
  const source = lstatSync(ocDir, { throwIfNoEntry: false });

  if (!source) {
    mkdirSync(persistDir, { recursive: true, mode: 0o700 });
    symlinkSync(persistDir, ocDir);
  } else if (source.isSymbolicLink()) {
    const actualTarget = resolve(dirname(ocDir), readlinkSync(ocDir));
    if (actualTarget !== resolve(persistDir)) {
      throw new Error(`wallet session symlink targets ${actualTarget}, expected ${resolve(persistDir)}`);
    }
  } else if (source.isDirectory()) {
    if (existsSync(persistDir)) {
      throw new Error("wallet session exists in both ephemeral and persistent storage; refusing destructive merge");
    }
    const staging = `${persistDir}.migrate-${randomUUID()}`;
    const backup = `${ocDir}.migrate-${randomUUID()}`;
    try {
      cpSync(ocDir, staging, { recursive: true, errorOnExist: true, preserveTimestamps: true });
      renameSync(staging, persistDir);
      renameSync(ocDir, backup);
      try {
        symlinkSync(persistDir, ocDir);
      } catch (error) {
        renameSync(backup, ocDir);
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  } else {
    throw new Error("wallet session path is neither a directory nor the expected symlink");
  }
  console.log(`[bind] onchainos session persisted -> ${persistDir}`);
}
persistOnchainosSession();

const recoveredPaymentLocks = recoverStalePaymentClaimLocks();
if (recoveredPaymentLocks > 0) console.log(`[bind] recovered stale payment claim locks=${recoveredPaymentLocks}`);

const paymentReconciliation = await reconcilePaymentClaimsOnStartup(
  (executionId) => loadExecution(executionId),
  undefined,
  async (claim) => {
    const refund = await refundExactBaseUnits(
      claim.amountBaseUnits ?? "0",
      claim.payer,
      `orphan-custody:${claim.key}`,
      { tokenAddress: claim.token, senderAddress: claim.sender },
    );
    if (refund.state === "confirmed") return { state: "confirmed" as const, txHash: refund.txHash };
    if (refund.state === "submitted") return { state: "submitted" as const, txHash: refund.txHash };
    return { state: "failed" as const, reason: refund.reason ?? refund.state };
  },
);
console.log(`[bind] payment claim reconciliation inspected=${paymentReconciliation.inspected} blocked=${paymentReconciliation.blockedForReconciliation} completed=${paymentReconciliation.completedFromDurableExecution} orphanRefunded=${paymentReconciliation.refundedOrphanCustody}`);
if (paymentReconciliation.blockedForReconciliation > 0) {
  throw new Error("unresolved payment liabilities block startup; reconcile durable claims before accepting new missions");
}

const server = app.listen(config.port, () => {
  console.log(`[bind] listening on :${config.port}  (paymentConfigured=${isConfiguredForPayment()})`);
  // Warm the marketplace catalog in the background so the first mission doesn't pay the
  // cold-start cost. Failures are non-fatal — the first plan will just refresh it.
  warmCatalog()
    .then((n) => console.log(`[bind] marketplace catalog warmed: ${n} agents`))
    .catch((e) => console.warn(`[bind] catalog warm failed (non-fatal): ${(e as Error).message}`));
  // Grow the crew while we sleep: budget-capped nightly payability probe.
  scheduleAutoprobe();
  // A2A task worker: apply to + deliver marketplace tasks (off unless BIND_A2A=1).
  scheduleA2AWorker();
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
