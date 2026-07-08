// Data-deliverable harness: parses CSV/JSON into a table, runs an unconditional
// forensics pass (row/column/null/duplicate stats), then checks each criterion and
// emits concrete evidence — which rows failed, what values were seen. Pure Node.
import type { CriterionResult, Evidence } from "../report.js";
import type { Check, Criterion, Deliverable, Harness, HarnessResult } from "./types.js";

type Cell = string | number | boolean | null;
interface Table {
  columns: string[];
  records: Array<Record<string, Cell>>;
}

const MAX_LISTED = 10; // cap offending-row lists so evidence stays readable

// Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes, and CRLF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); field = ""; row = []; }
    else if (c === "\r") { /* handled by \n */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function toTable(d: Deliverable): Table {
  const fmt = d.format.toLowerCase();
  if (fmt === "csv") {
    const rows = parseCsv(d.content).filter((r) => !(r.length === 1 && r[0] === ""));
    const columns = rows.shift() ?? [];
    const records = rows.map((r) => {
      const rec: Record<string, Cell> = {};
      columns.forEach((col, i) => {
        const v = r[i] ?? "";
        rec[col] = v === "" ? null : v;
      });
      return rec;
    });
    return { columns, records };
  }
  if (fmt === "json") {
    const parsed: unknown = JSON.parse(d.content);
    if (!Array.isArray(parsed)) throw new Error("JSON deliverable must be an array of row objects");
    const records = parsed as Array<Record<string, Cell>>;
    const cols = new Set<string>();
    for (const rec of records) for (const k of Object.keys(rec ?? {})) cols.add(k);
    return { columns: [...cols], records };
  }
  throw new Error(`unsupported data format: ${d.format}`);
}

function asNumber(v: Cell): number | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function forensics(t: Table): Evidence[] {
  const nulls: Record<string, number> = {};
  for (const col of t.columns) {
    nulls[col] = t.records.filter((r) => r[col] === null || r[col] === undefined).length;
  }
  return [
    { kind: "row_count", detail: `${t.records.length} data row(s)`, data: t.records.length },
    { kind: "columns", detail: t.columns.join(", ") || "(none)", data: t.columns },
    { kind: "null_counts", detail: summarizeNulls(nulls), data: nulls },
  ];
}
function summarizeNulls(nulls: Record<string, number>): string {
  const bad = Object.entries(nulls).filter(([, n]) => n > 0);
  return bad.length === 0 ? "no null cells" : bad.map(([c, n]) => `${c}: ${n}`).join(", ");
}

function runCheck(t: Table, c: Criterion): CriterionResult {
  const base = { criterionId: c.id, description: c.description };
  try {
    const { status, evidence } = evaluate(t, c.check);
    return { ...base, status, evidence };
  } catch (e) {
    return { ...base, status: "error", evidence: [{ kind: "error", detail: (e as Error).message }] };
  }
}

function evaluate(t: Table, check: Check): { status: "pass" | "fail"; evidence: Evidence[] } {
  switch (check.kind) {
    case "columns_present": {
      const missing = check.columns.filter((col) => !t.columns.includes(col));
      return missing.length === 0
        ? { status: "pass", evidence: [{ kind: "columns_present", detail: `all present: ${check.columns.join(", ")}` }] }
        : { status: "fail", evidence: [{ kind: "columns_missing", detail: `missing: ${missing.join(", ")}`, data: missing }] };
    }
    case "row_count_min":
      return t.records.length >= check.min
        ? { status: "pass", evidence: [{ kind: "row_count", detail: `${t.records.length} >= ${check.min}` }] }
        : { status: "fail", evidence: [{ kind: "row_count", detail: `${t.records.length} < required ${check.min}` }] };
    case "row_count_max":
      return t.records.length <= check.max
        ? { status: "pass", evidence: [{ kind: "row_count", detail: `${t.records.length} <= ${check.max}` }] }
        : { status: "fail", evidence: [{ kind: "row_count", detail: `${t.records.length} > allowed ${check.max}` }] };
    case "no_nulls": {
      const offenders: Array<{ row: number; column: string }> = [];
      check.columns.forEach((col) => {
        t.records.forEach((r, i) => {
          if (r[col] === null || r[col] === undefined) offenders.push({ row: i + 1, column: col });
        });
      });
      return offenders.length === 0
        ? { status: "pass", evidence: [{ kind: "no_nulls", detail: `no nulls in ${check.columns.join(", ")}` }] }
        : { status: "fail", evidence: [{ kind: "nulls_found", detail: `${offenders.length} null cell(s); first: ${sample(offenders)}`, data: offenders.slice(0, MAX_LISTED) }] };
    }
    case "unique": {
      const seen = new Map<string, number>();
      const dups: Array<{ row: number; key: string }> = [];
      t.records.forEach((r, i) => {
        const key = check.columns.map((col) => String(r[col] ?? "∅")).join("│");
        if (seen.has(key)) dups.push({ row: i + 1, key });
        else seen.set(key, i + 1);
      });
      return dups.length === 0
        ? { status: "pass", evidence: [{ kind: "unique", detail: `${check.columns.join("+")} unique across ${t.records.length} rows` }] }
        : { status: "fail", evidence: [{ kind: "duplicates_found", detail: `${dups.length} duplicate(s); first: ${sample(dups)}`, data: dups.slice(0, MAX_LISTED) }] };
    }
    case "numeric": {
      const offenders: Array<{ row: number; value: Cell }> = [];
      t.records.forEach((r, i) => {
        if (asNumber(r[check.column]) === null) offenders.push({ row: i + 1, value: r[check.column] });
      });
      return offenders.length === 0
        ? { status: "pass", evidence: [{ kind: "numeric", detail: `all values in ${check.column} are numeric` }] }
        : { status: "fail", evidence: [{ kind: "non_numeric", detail: `${offenders.length} non-numeric in ${check.column}; first: ${sample(offenders)}`, data: offenders.slice(0, MAX_LISTED) }] };
    }
    case "numeric_range": {
      const offenders: Array<{ row: number; value: Cell }> = [];
      t.records.forEach((r, i) => {
        const n = asNumber(r[check.column]);
        const out = n === null || (check.min !== undefined && n < check.min) || (check.max !== undefined && n > check.max);
        if (out) offenders.push({ row: i + 1, value: r[check.column] });
      });
      const bounds = `[${check.min ?? "-∞"}, ${check.max ?? "∞"}]`;
      return offenders.length === 0
        ? { status: "pass", evidence: [{ kind: "numeric_range", detail: `all ${check.column} within ${bounds}` }] }
        : { status: "fail", evidence: [{ kind: "out_of_range", detail: `${offenders.length} value(s) outside ${bounds}; first: ${sample(offenders)}`, data: offenders.slice(0, MAX_LISTED) }] };
    }
    default:
      throw new Error(`'${(check as { kind: string }).kind}' is not a data check`);
  }
}

function sample(items: unknown[]): string {
  return JSON.stringify(items.slice(0, 3));
}

export class DataHarness implements Harness {
  readonly type = "data";
  run(deliverable: Deliverable, criteria: Criterion[]): HarnessResult {
    const table = toTable(deliverable);
    return {
      forensics: forensics(table),
      results: criteria.map((c) => runCheck(table, c)),
    };
  }
}
