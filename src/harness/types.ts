// A harness turns (deliverable + acceptance criteria) into evidence-backed results.
// Each deliverable type (data, code, content) has its own harness; they all emit the
// same CriterionResult/Evidence shape so reports are uniform regardless of type.
import type { CriterionResult, Evidence } from "../report.js";

export interface Deliverable {
  format: string;   // e.g. "csv" | "json"
  content: string;
}

// A machine-checkable criterion. `check` is a discriminated union so each kind
// carries exactly the parameters it needs. compile_spec (LLM) will emit these;
// they can also be supplied directly for the calibration benchmark.
export type Check =
  // data checks
  | { kind: "columns_present"; columns: string[] }
  | { kind: "row_count_min"; min: number }
  | { kind: "row_count_max"; max: number }
  | { kind: "no_nulls"; columns: string[] }
  | { kind: "unique"; columns: string[] }
  | { kind: "numeric"; column: string }
  | { kind: "numeric_range"; column: string; min?: number; max?: number }
  // content checks
  | { kind: "must_include"; phrases: string[]; mode?: "all" | "any" }
  | { kind: "must_not_include"; phrases: string[] }
  | { kind: "min_words"; min: number }
  | { kind: "max_words"; max: number }
  | { kind: "no_placeholders" }
  | { kind: "ai_disclosure_present" }
  | { kind: "no_duplicate_paragraphs" }
  // code checks (Python only for now — see harness/code.ts)
  | { kind: "syntax_valid" }
  | { kind: "tests_pass"; testCode: string }
  | { kind: "no_banned_imports"; modules: string[] };

export interface Criterion {
  id: string;
  description: string;
  check: Check;
}

export interface HarnessResult {
  results: CriterionResult[];
  forensics: Evidence[]; // unconditional summary artifacts (the "forensics" pass)
}

export interface Harness {
  readonly type: string;
  run(deliverable: Deliverable, criteria: Criterion[]): HarnessResult | Promise<HarnessResult>;
}
