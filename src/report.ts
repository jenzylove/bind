// Report model + integrity: canonical JSON, SHA-256, and an ed25519 signature over
// the report hash. The hash is what gets anchored on X Layer (Phase 2); the signature
// lets anyone verify a report came from this service and was not altered.
import {
  createHash, generateKeyPairSync, sign as edSign, verify as edVerify,
  createPrivateKey, createPublicKey, type KeyObject, randomUUID,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Evidence {
  kind: string;
  detail: string;
  data?: unknown;
}
export type CriterionStatus = "pass" | "fail" | "error";
export interface CriterionResult {
  criterionId: string;
  description: string;
  status: CriterionStatus;
  evidence: Evidence[];
}
export interface Score {
  passed: number;
  failed: number;
  errored: number;
  total: number;
}
export interface Anchor {
  chain: string;
  txHash: string;
}

// The subset of a report that is hashed and signed. Anything outside this
// (the signature, the on-chain anchor) is metadata added after finalization.
export interface ReportCore {
  id: string;
  createdAt: string;
  tool: "inspect_delivery";
  deliverableType: string;
  deliverableSha256: string;
  criteriaSha256: string;
  results: CriterionResult[];
  forensics: Evidence[];
  score: Score;
  verdict: "pass" | "fail";
}
export interface Report extends ReportCore {
  reportSha256: string;
  algorithm: "ed25519";
  signature: string;        // hex
  signerPublicKey: string;  // base64 SPKI DER
  anchor: Anchor | null;
}

// --- Canonicalization & hashing ---------------------------------------------

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortDeep(o[k]);
      return acc;
    }, {});
  }
  return v;
}
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// --- Service signing key -----------------------------------------------------

const KEY_PATH = process.env.SERVICE_KEY_PATH ?? "data/service-key.pem";
let priv: KeyObject | null = null;
let pub: KeyObject | null = null;

function loadKeys(): void {
  if (priv && pub) return;
  if (existsSync(KEY_PATH)) {
    priv = createPrivateKey(readFileSync(KEY_PATH));
  } else {
    const { privateKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    writeFileSync(KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    priv = privateKey;
  }
  pub = createPublicKey(priv);
}
export function signerPublicKeyBase64(): string {
  loadKeys();
  return (pub!.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}
function signHex(message: string): string {
  loadKeys();
  return edSign(null, Buffer.from(message, "utf8"), priv!).toString("hex");
}

// --- Finalize & verify -------------------------------------------------------

export function finalizeReport(core: ReportCore): Report {
  const reportSha256 = sha256Hex(canonicalize(core));
  return {
    ...core,
    reportSha256,
    algorithm: "ed25519",
    signature: signHex(reportSha256),
    signerPublicKey: signerPublicKeyBase64(),
    anchor: null,
  };
}

// Independent verification: recompute the hash from the core fields and check
// the signature. Returns why it failed so a verifier tool can report precisely.
export function verifyReport(r: Report): { ok: boolean; reason?: string } {
  const core: ReportCore = {
    id: r.id, createdAt: r.createdAt, tool: r.tool,
    deliverableType: r.deliverableType, deliverableSha256: r.deliverableSha256,
    criteriaSha256: r.criteriaSha256, results: r.results, forensics: r.forensics,
    score: r.score, verdict: r.verdict,
  };
  const recomputed = sha256Hex(canonicalize(core));
  if (recomputed !== r.reportSha256) return { ok: false, reason: "hash_mismatch" };
  try {
    const pubKey = createPublicKey({
      key: Buffer.from(r.signerPublicKey, "base64"), format: "der", type: "spki",
    });
    const ok = edVerify(null, Buffer.from(r.reportSha256, "utf8"), pubKey, Buffer.from(r.signature, "hex"));
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "verify_error" };
  }
}

export function newReportId(): string {
  return randomUUID();
}

export function tally(results: CriterionResult[]): Score {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errored = results.filter((r) => r.status === "error").length;
  return { passed, failed, errored, total: results.length };
}
