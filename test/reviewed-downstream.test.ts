import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewedDownstreamIdentities } from "../src/bind/reviewed-downstream.js";

const ENDPOINT = "https://agent.example/x402/run";
const PAYEE = "0x1111111111111111111111111111111111111111";

test("reviewed downstream registry pins one exact endpoint to one exact payee", () => {
  const registry = parseReviewedDownstreamIdentities(JSON.stringify([{ endpoint: ENDPOINT, payTo: PAYEE }]));
  assert.equal(registry.get(ENDPOINT), PAYEE);
  assert.equal(registry.get(`${ENDPOINT}/`), undefined);
  assert.equal(registry.get(`${ENDPOINT}?mode=other`), undefined);
});

test("reviewed downstream registry rejects malformed, duplicate, and unsafe identities", () => {
  assert.equal(parseReviewedDownstreamIdentities("not json").size, 0);
  assert.equal(parseReviewedDownstreamIdentities(JSON.stringify([
    { endpoint: "http://agent.example/x402/run", payTo: PAYEE },
    { endpoint: "https://user:pass@agent.example/x402/run", payTo: PAYEE },
    { endpoint: `${ENDPOINT}#fragment`, payTo: PAYEE },
    { endpoint: ENDPOINT, payTo: "not-an-address" },
  ])).size, 0);

  const duplicate = parseReviewedDownstreamIdentities(JSON.stringify([
    { endpoint: ENDPOINT, payTo: PAYEE },
    { endpoint: ENDPOINT, payTo: "0x2222222222222222222222222222222222222222" },
  ]));
  assert.equal(duplicate.size, 1);
  assert.equal(duplicate.get(ENDPOINT), PAYEE);
});
