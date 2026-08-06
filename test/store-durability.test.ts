import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindExecution } from "../src/bind/types.js";

const dir = await mkdtemp(join(tmpdir(), "bind-store-test-"));
process.env.BIND_DATA_DIR = dir;
const { loadExecution, saveExecution } = await import("../src/bind/store.js");

function execution(status: BindExecution["status"] = "running"): BindExecution {
  return {
    executionId: "55555555-5555-4555-8555-555555555555",
    planId: "66666666-6666-4666-8666-666666666666",
    goal: "durability test",
    status,
    stepResults: [],
    totalPaid: 0,
    totalSteps: 1,
    completedSteps: 0,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

test.after(async () => rm(dir, { recursive: true, force: true }));

test("failed replacement cannot truncate the prior durable execution", async () => {
  const original = execution();
  saveExecution(original);
  const path = join(dir, "executions", `${original.executionId}.json`);
  const before = await readFile(path, "utf8");

  const unserializable = { ...original, status: "completed", poison: 1n } as unknown as BindExecution;
  assert.throws(() => saveExecution(unserializable), /serialize|bigint/i);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(loadExecution(original.executionId)?.status, "running");
});

test("paid-path persistence throws when the data directory is unavailable", async () => {
  const blocker = join(dir, "blocked");
  await writeFile(blocker, "not a directory");
  process.env.BIND_DATA_DIR = blocker;

  // A query string gives this probe its own module instance and configuration snapshot.
  const isolated = await import(`../src/bind/store.js?blocked=${Date.now()}`);
  assert.throws(() => isolated.saveExecution(execution("failed")), /ENOTDIR|not a directory/i);
});
