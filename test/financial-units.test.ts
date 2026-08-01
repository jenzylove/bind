import test from "node:test";
import assert from "node:assert/strict";
import { parseUsdtBalanceBaseUnits } from "../src/bind/executor.js";

test("USDT wallet balances parse to exact six-decimal base units", () => {
  assert.equal(parseUsdtBalanceBaseUnits("0"), 0n);
  assert.equal(parseUsdtBalanceBaseUnits("12"), 12_000_000n);
  assert.equal(parseUsdtBalanceBaseUnits("12.3"), 12_300_000n);
  assert.equal(parseUsdtBalanceBaseUnits("12.345678"), 12_345_678n);
});

test("USDT wallet balance parsing fails closed on noncanonical precision", () => {
  assert.equal(parseUsdtBalanceBaseUnits("12.3456789"), null);
  assert.equal(parseUsdtBalanceBaseUnits("1e3"), null);
  assert.equal(parseUsdtBalanceBaseUnits("-1"), null);
  assert.equal(parseUsdtBalanceBaseUnits("NaN"), null);
  assert.equal(parseUsdtBalanceBaseUnits(undefined), null);
});
