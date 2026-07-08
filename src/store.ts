// Report persistence. File-backed for now (one JSON per report); a SQLite/Postgres
// swap is a drop-in later. Reports are public-by-id — the id is unguessable (UUID).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Report, Anchor } from "./report.js";

const DIR = process.env.REPORT_DIR ?? "data/reports";

export function saveReport(r: Report): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${r.id}.json`), JSON.stringify(r, null, 2));
}

export function loadReport(id: string): Report | null {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null; // only accept UUID-shaped ids
  const p = join(DIR, `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Report) : null;
}

// Patches in the on-chain anchor after the fact -- anchoring happens
// asynchronously, well after the report was already saved and returned to
// the caller. The report's hash/signature are untouched (anchor sits outside
// the signed core), so this never invalidates verification.
export function updateReportAnchor(id: string, anchor: Anchor): void {
  const r = loadReport(id);
  if (!r) return;
  r.anchor = anchor;
  saveReport(r);
}
