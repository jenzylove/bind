export interface ReviewedDownstreamIdentity {
  endpoint: string;
  payTo: string;
}

function canonicalEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function parseReviewedDownstreamIdentities(raw: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw) return result;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return result; }
  if (!Array.isArray(parsed)) return result;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const endpoint = canonicalEndpoint(String((item as any).endpoint ?? ""));
    const payTo = String((item as any).payTo ?? "").toLowerCase();
    if (!endpoint || !/^0x[0-9a-f]{40}$/.test(payTo) || result.has(endpoint)) continue;
    result.set(endpoint, payTo);
  }
  return result;
}

const reviewed = parseReviewedDownstreamIdentities(process.env.BIND_REVIEWED_DOWNSTREAM_IDENTITIES);

/** Exact marketplace endpoint identity to reviewed payment recipient. No prefix or substring matching. */
export function reviewedPayeeForEndpoint(endpoint: string): string | null {
  const canonical = canonicalEndpoint(endpoint);
  return canonical ? reviewed.get(canonical) ?? null : null;
}
