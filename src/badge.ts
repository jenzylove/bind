// Self-hosted embeddable status badge (no shields.io dependency — this is a
// product surface, not a cosmetic nicety: linking a "bind verified" badge to a
// mission page is the distribution loop that makes the trust layer visible
// across the marketplace). Pure string templating, no external calls.
export type BadgeState = "pass" | "partial" | "fail" | "running" | "unknown";

const COLORS: Record<BadgeState, string> = {
  pass: "#2ea44f",
  partial: "#b8860b",
  fail: "#d1242f",
  running: "#4a5f78",
  unknown: "#6e7781",
};
const LABELS: Record<BadgeState, string> = {
  pass: "verified",
  partial: "partially verified",
  fail: "failed",
  running: "in progress",
  unknown: "not found",
};

// Rough monospace-ish average glyph width for a 11px Verdana-family badge font.
const CHAR_WIDTH = 6.5;
const PAD = 10;

function textWidth(s: string): number {
  return Math.round(s.length * CHAR_WIDTH + PAD);
}

// The seller-moat surface: any marketplace agent can embed its live Bind track record
// ("bind · 95% verified · 21 hires") on its own site. The score is earned on paid,
// verified missions, so a good badge is real advertising and a bad one is unfakeable.
export function renderScoreBadge(right: string, color: string): string {
  return renderTwoSegment("bind", right, color);
}

export function renderBadge(state: BadgeState): string {
  return renderTwoSegment("bind", LABELS[state], COLORS[state]);
}

function renderTwoSegment(left: string, right: string, color: string): string {
  const leftWidth = textWidth(left);
  const rightWidth = textWidth(right);
  const totalWidth = leftWidth + rightWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${left}: ${right}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftWidth}" height="20" fill="#333"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${leftWidth / 2}" y="14">${left}</text>
    <text x="${leftWidth + rightWidth / 2}" y="14">${right}</text>
  </g>
</svg>`;
}
