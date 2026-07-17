// Bind — the orchestrator for the agent economy
// Built on x402 payment, inter-step verification, and on-chain anchoring
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, isConfiguredForPayment } from "./config.js";
import { requirePayment } from "./x402.js";
import { bindRouter } from "./bind/routes.js";
import { renderBadge, renderScoreBadge } from "./badge.js";
import { loadExecution } from "./bind/store.js";
import { warmCatalog } from "./bind/marketplace.js";
import { renderMissionPage } from "./bind/mission-page.js";
import { scheduleAutoprobe } from "./bind/autoprobe.js";
import { renderAgentPage, scoreColor, scoreLabel } from "./bind/agent-page.js";
import { agentEvidence } from "./bind/reputation.js";

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

// Serve the web demo UI. Both /app and /bind/app resolve to the same page
// (there is no separate app.html — pointing /app here fixes a 404).
app.get(["/app", "/bind/app"], (_req, res) => {
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

// Status badge for Bind executions — reflects the real execution outcome.
app.get("/badge/:executionId.svg", (req, res) => {
  const exec = loadExecution(req.params.executionId);
  const state =
    !exec ? "unknown"
    : exec.status === "completed" ? "pass"
    : exec.status === "partial" ? "partial"
    : exec.status === "running" ? "running"
    : "fail";
  res.type("image/svg+xml").set("Cache-Control", "no-cache").send(renderBadge(state));
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

// Public mission page: the goal, the crew, every payment and verification, the refund,
// and the on-chain anchor — a shareable proof artifact for every mission.
app.get("/m/:executionId", (req, res) => {
  const exec = loadExecution(req.params.executionId);
  if (!exec) {
    res.status(404).type("html").send("<body style='background:#16120b;color:#e7ddc7;font-family:Georgia,serif;text-align:center;padding-top:80px'><h2>No mission with that id.</h2><a style='color:#c8a45a' href='/'>Back to Bind</a></body>");
    return;
  }
  res.type("html").send(renderMissionPage(exec));
});

const server = app.listen(config.port, () => {
  console.log(`[bind] listening on :${config.port}  (paymentConfigured=${isConfiguredForPayment()})`);
  // Warm the marketplace catalog in the background so the first mission doesn't pay the
  // cold-start cost. Failures are non-fatal — the first plan will just refresh it.
  warmCatalog()
    .then((n) => console.log(`[bind] marketplace catalog warmed: ${n} agents`))
    .catch((e) => console.warn(`[bind] catalog warm failed (non-fatal): ${(e as Error).message}`));
  // Grow the crew while we sleep: budget-capped nightly payability probe.
  scheduleAutoprobe();
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
