// Render Bind's agent avatar to a real PNG file: the cream notary seal on a SOLID dark
// square (opaque corners, gilt keyline) so it is unambiguously 1:1 with square corners.
// Ported from the brand-kit canvas. Output: brand/bind-avatar.png
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync } from "node:fs";

const S = 800, cx = 400, cy = 400;
const PAPER = "#e7ddc7", PAPER_HI = "#efe7d5", PAPER_LO = "#cfc0a0", INK = "#211a12", FADED = "#6a5e46", WAX = "#7c2f27";

const c = createCanvas(S, S);
const ctx = c.getContext("2d");

// solid dark square, opaque to the edges
ctx.fillStyle = "#16120b"; ctx.fillRect(0, 0, S, S);
const vg = ctx.createRadialGradient(cx, cy * 0.9, 40, cx, cy, S * 0.62);
vg.addColorStop(0, "#221a10"); vg.addColorStop(1, "#16120b");
ctx.fillStyle = vg; ctx.fillRect(0, 0, S, S);
// gilt keyline just inside the edge — makes the square frame deliberate
ctx.strokeStyle = "rgba(200,164,90,0.5)"; ctx.lineWidth = 4; ctx.strokeRect(22, 22, S - 44, S - 44);

function diamond(x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillStyle = color; ctx.fillRect(-s / 2, -s / 2, s, s); ctx.restore();
}
function arcText(text, radius, midAngle, opts) {
  const { size, spacing = 0, color = INK, flip = false, weight = 400 } = opts;
  ctx.save(); ctx.fillStyle = color; ctx.font = `${weight} ${size}px Georgia, serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const widths = [...text].map((ch) => ctx.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0);
  const angSpan = total / radius;
  let ang = midAngle - (flip ? -angSpan / 2 : angSpan / 2);
  for (let i = 0; i < text.length; i++) {
    const w = widths[i]; const step = w / radius;
    const a = ang + (flip ? -step / 2 : step / 2);
    const x = cx + radius * Math.cos(a), y = cy + radius * Math.sin(a);
    ctx.save(); ctx.translate(x, y); ctx.rotate(flip ? a - Math.PI / 2 : a + Math.PI / 2);
    ctx.fillText(text[i], 0, 0); ctx.restore();
    ang += flip ? -step : step;
  }
  ctx.restore();
}

// the seal, scaled so a dark border frames it
ctx.save();
ctx.translate(cx, cy); ctx.scale(0.82, 0.82); ctx.translate(-cx, -cy);

// cream seal disc
const disc = ctx.createRadialGradient(cx, cy * 0.95, 30, cx, cy, 400);
disc.addColorStop(0, PAPER_HI); disc.addColorStop(0.7, PAPER); disc.addColorStop(1, PAPER_LO);
ctx.fillStyle = disc; ctx.beginPath(); ctx.arc(cx, cy, 384, 0, 7); ctx.fill();

// rings
ctx.strokeStyle = INK;
ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, 372, 0, 7); ctx.stroke();
ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, 352, 0, 7); ctx.stroke();
ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, 262, 0, 7); ctx.stroke();
// rim text
arcText("BIND", 307, -Math.PI / 2, { size: 66, weight: 700, spacing: 8 });
arcText("THE  GENERAL  CONTRACTOR  FOR  AGENTS", 307, Math.PI / 2, { size: 31, spacing: 3, flip: true, color: FADED });
diamond(cx - 307, cy, 12, INK); diamond(cx + 307, cy, 12, INK);
// engraving hatch in the medallion
ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, 262, 0, 7); ctx.clip();
ctx.strokeStyle = "rgba(33,26,18,0.06)"; ctx.lineWidth = 2;
for (let x = -200; x < 800; x += 14) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 400, 800); ctx.stroke(); }
ctx.restore();
// wax ring + monogram
ctx.strokeStyle = WAX; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, 236, 0, 7); ctx.stroke();
ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
ctx.font = "700 300px Georgia, serif"; ctx.fillText("B", cx, cy + 18);
ctx.fillStyle = FADED; ctx.font = "italic 30px Georgia, serif"; ctx.fillText("verified", cx, cy + 150);
ctx.restore();

mkdirSync("brand", { recursive: true });
writeFileSync("brand/bind-avatar.png", c.toBuffer("image/png"));
console.log("wrote brand/bind-avatar.png", (c.toBuffer("image/png").length / 1024).toFixed(0) + "KB");
