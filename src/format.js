function countBy(items, key) {
  return items.reduce((result, item) => { const value = item[key] ?? "unknown"; result[value] = (result[value] ?? 0) + 1; return result; }, {});
}

export function formatInventory(inventory) {
  const counts = countBy(inventory.components, "kind");
  const lines = [`Scanned ${inventory.components.length} components`, `  Plugins: ${counts.plugin ?? 0}`, `  Skills:  ${counts.skill ?? 0}`, `  State generated: ${inventory.generatedAt}`];
  return lines.join("\n");
}

export function formatAnalysis(analysis) {
  const counts = countBy(analysis.findings, "severity");
  const lines = [`Inventory: ${analysis.inventoryMode ?? "unknown"} (${analysis.inventoryGeneratedAt ?? "unknown time"})`, `Found ${analysis.findings.length} actionable findings`, `  High:   ${counts.high ?? 0}`, `  Medium: ${counts.medium ?? 0}`, `Coverage: ${analysis.coverage.totalSkills} Skills; ${analysis.coverage.missingDescription} missing descriptions, ${analysis.coverage.missingTriggers} without explicit triggers, ${analysis.coverage.missingTools} without explicit tools`, `Risk inventory: ${Object.entries(analysis.riskInventory).map(([name, count]) => `${name}=${count}`).join(", ") || "none"}`];
  for (const finding of analysis.findings.slice(0, 20)) {
    lines.push(`- [${finding.severity}] ${finding.type}: ${finding.componentId ?? finding.components?.join(" <> ")}`);
  }
  if (analysis.findings.length > 20) lines.push("- ... use --json for all findings");
  return lines.join("\n");
}

function formatPlanItem(item) {
  if (!item) return "none";
  return `${item.name} [${item.runtime}] (${item.score})${item.requiresApproval ? " [approval]" : ""}`;
}

export function formatPlan(plan) {
  const lines = [`Inventory: ${plan.inventoryMode ?? "unknown"} (${plan.inventoryGeneratedAt ?? "unknown time"})`, `Task: ${plan.task}`, `Personal Method: ${plan.methodId ?? "none"}`, `Primary: ${formatPlanItem(plan.primary)}`, `Augment: ${plan.augment.length ? plan.augment.map(formatPlanItem).join(", ") : "none"}`, `Risks: ${plan.risks.length ? plan.risks.join(", ") : "none"}`, `Why: ${plan.explanation}`];
  if (plan.correction) lines.push(`Personal correction: ${plan.correction}`);
  return lines.join("\n");
}
