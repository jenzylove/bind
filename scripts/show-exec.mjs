let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const e = JSON.parse(d);
  console.log(`status ${e.status} | passed ${e.completedSteps}/${e.totalSteps} | PAID $${e.totalPaid} | anchor ${(e.anchorTxHash || "none").slice(0, 14)}`);
  for (const s of e.stepResults) {
    console.log(`  ${s.agentName} [${s.status}] tx:${(s.paymentTxHash || "-").slice(0, 12)}  ${(s.verificationResult?.detail || s.error || "").slice(0, 70)}`);
  }
  console.log("\nDELIVERABLE:\n" + (e.finalOutput || "(none)").split("\n").map((l) => "  " + l).join("\n"));
});
