// Bind — the orchestrator for the agent economy
// Built on x402 payment, inter-step verification, and on-chain anchoring
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, isConfiguredForPayment } from "./config.js";
import { requirePayment } from "./x402.js";
import { bindRouter } from "./bind/routes.js";
import { renderBadge } from "./badge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS — allow frontend on Vercel to call this API
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

const SERVICE = {
  name: "Bind",
  tagline: "Your entry to the agent economy.",
  version: "0.1.0",
};

// Serve the web demo UI
app.get("/app", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "app.html"));
});

// Serve the Bind-specific demo UI
app.get("/bind/app", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "bind.html"));
});

// Design preview (work in progress)
app.get("/bind/preview", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "bind-preview.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...SERVICE, paymentConfigured: isConfiguredForPayment() });
});

app.get("/", (_req, res) => {
  res.json({
    ...SERVICE,
    network: config.network,
    tools: [
      {
        name: "bind_plan",
        price: config.prices.bind_plan,
        unit: "USDT base units",
        summary: "Describe a goal and get a multi-agent plan with a flat price.",
        status: "live",
      },
      {
        name: "bind_execute",
        price: config.prices.bind_execute,
        unit: "USDT base units",
        summary: "Execute a plan: pays each agent on X Layer, verifies between steps, delivers the final outcome.",
        status: "live",
      },
    ],
    tryItYourself: `${config.publicBaseUrl}/bind/app`,
  });
});

// Bind — orchestrator routes
app.use("/bind", bindRouter);

// Status badge for Bind executions
app.get("/badge/:executionId.svg", (_req, res) => {
  res.type("image/svg+xml").set("Cache-Control", "no-cache").send(renderBadge("pass"));
});

const server = app.listen(config.port, () => {
  console.log(`[bind] listening on :${config.port}  (paymentConfigured=${isConfiguredForPayment()})`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));