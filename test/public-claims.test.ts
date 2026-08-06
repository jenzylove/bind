import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/bind.html", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/bind/routes.ts", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const receipt = await readFile(new URL("../src/bind/receipt.ts", import.meta.url), "utf8");
const serviceReliability = await readFile(new URL("../src/bind/service-reliability.ts", import.meta.url), "utf8");
const legacyX402 = await readFile(new URL("../src/x402.ts", import.meta.url), "utf8");
const theme = await readFile(new URL("../public/bind-theme.css", import.meta.url), "utf8");

test("public content is fail-visible without scroll observer initialization", () => {
  assert.doesNotMatch(html, /IntersectionObserver|initReveals|classList\.add\(['"]reveal/);
  assert.doesNotMatch(theme, /\.reveal\s*\{[^}]*opacity\s*:\s*0/s);
});

test("browser never places execution capabilities in public URLs or share surfaces", () => {
  assert.doesNotMatch(html, /\?exec=|URLSearchParams\(location\.search\)/);
  assert.doesNotMatch(html, /`\/m\/\$\{|public mission page/i);
  assert.doesNotMatch(html, /twitter\.com\/intent\/tweet[\s\S]{0,500}executionId/);
  assert.match(html, /sessionStorage\.setItem\(['"]bindExecutionId/);
  assert.match(html, /const url = `\$\{location\.origin\}\/mission`/);
  assert.match(server, /app\.get\(\[[^\]]*["']\/mission["']/);
  assert.doesNotMatch(server, /app\.get\(["']\/m\/:executionId/);
  assert.doesNotMatch(receipt, /reportUrl|publicBaseUrl.*\/m\//);
});

test("browser renderer consumes only the redacted showcase schema", () => {
  assert.match(html, /data\.services/);
  assert.match(html, /data\.progress/);
  assert.match(html, /data\.totalAgentFeesUsdt/);
  assert.match(html, /data\.refund/);
  assert.match(html, /data\.receipt/);
  assert.doesNotMatch(html, /data\.stepResults|data\.finalOutput|data\.totalPaid|data\.refundAmountDueUsdt|data\.refundTxHash/);
});

test("public UI does not enumerate wallet history", () => {
  assert.doesNotMatch(html, /\/bind\/history/);
  assert.doesNotMatch(html, /historyCard|historyList|m\.evidenceId/);
});

test("public copy distinguishes recorded, submitted, and confirmed evidence", () => {
  assert.doesNotMatch(html, /Every hire is a paid, verified, on-chain data point/i);
  assert.doesNotMatch(html, /paid on X Layer/i);
  assert.doesNotMatch(html, /Refunded \(unused budget\)/i);
  assert.doesNotMatch(html, /paid agent hires/i);
  assert.doesNotMatch(html, /spends only after the buyer payment is verified/i);
  assert.doesNotMatch(html, /anchored on-chain/i);
  assert.match(html, /recorded call attempts/i);
  assert.doesNotMatch(html, /id="statHires">81</i);
  assert.doesNotMatch(html, /id="statAgents">14</i);
  assert.match(html, /receipt commitment/i);
  assert.match(html, /refund submitted/i);
  assert.doesNotMatch(html, /`<span>\$\{e\.completedSteps\}/);
  assert.doesNotMatch(html, /steps\.innerHTML \+=/);
  assert.doesNotMatch(html, /body\.innerHTML = logs/);
  assert.doesNotMatch(html, /missionLink\.innerHTML/);
  assert.doesNotMatch(html, /Paid to agents/i);
  assert.doesNotMatch(html, /agent budget refunded/i);
  assert.doesNotMatch(routes, /key:\s*r\.key/);
  assert.doesNotMatch(routes, /lastFailure:\s*r\.lastFailure/);
  assert.doesNotMatch(routes, /paidFailed:\s*r\.paidFailed/);
  assert.doesNotMatch(serviceReliability, /last failure:\s*\$\{rec\.lastFailure/);
});

test("legacy payment middleware cannot accept bearer text as proof", () => {
  assert.doesNotMatch(legacyX402, /return proof\.trim\(\)\.length > 0/);
  assert.doesNotMatch(legacyX402, /ALLOW_UNPAID/);
  assert.match(legacyX402, /requireX402/);
});

test("README states the current proof and verification boundaries", () => {
  assert.doesNotMatch(readme, /verifies every output/i);
  assert.doesNotMatch(readme, /on chain receipt showing exactly/i);
  assert.doesNotMatch(readme, /ALLOW_UNPAID/);
  assert.match(readme, /BIND_ALLOW_FREE/);
  assert.match(readme, /fail-open/i);
  assert.match(readme, /incoming onchainos submissions are accepted only after an independent successful X Layer receipt/i);
  assert.match(readme, /on-chain confirmation is not checked/i);
});
