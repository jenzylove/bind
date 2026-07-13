// Bind — the orchestrator for the agent economy
// Built on x402 payment, inter-step verification, and on-chain anchoring
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, isConfiguredForPayment } from "./config.js";
import { requirePayment } from "./x402.js";
import { bindRouter } from "./bind/routes.js";
import { renderBadge } from "./badge.js";
import { loadExecution } from "./bind/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "5mb" }));

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
        price: "0",
        listPrice: config.prices.bind_plan,
        unit: "USDT base units",
        summary: "Describe a goal and get a multi-agent plan with a flat price. Free to try during the hackathon launch.",
        status: "free-preview",
      },
      {
        name: "bind_execute",
        price: "0",
        listPrice: config.prices.bind_execute,
        unit: "USDT base units",
        summary: "Execute a plan: pays each agent on X Layer, verifies each output, returns one deliverable + on-chain receipt. You only pay the underlying agents; Bind's orchestration fee is waived during launch.",
        status: "free-preview",
      },
    ],
    tryItYourself: `${config.publicBaseUrl}/bind/app`,
  });
});

// Bind — orchestrator routes
app.use("/bind", bindRouter);

// Status badge for Bind executions — reflects the real execution outcome.
app.get("/badge/:executionId.svg", (req, res) => {
  const exec = loadExecution(req.params.executionId);
  const state = !exec ? "unknown" : exec.status === "completed" ? "pass" : "fail";
  res.type("image/svg+xml").set("Cache-Control", "no-cache").send(renderBadge(state));
});

const server = app.listen(config.port, () => {
  console.log(`[bind] listening on :${config.port}  (paymentConfigured=${isConfiguredForPayment()})`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));