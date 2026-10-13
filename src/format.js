function countBy(items, key) {
  return items.reduce((result, item) => { const value = item[key] ?? "unknown"; result[value] = (result[value] ?? 0) + 1; return result; }, {});
}

export function formatInventory(inventory) {
  const counts = countBy(inventory.components, "kind");
  const visible = inventory.components.filter((item) => item.lifecycle?.sessionVisible === true).length;
  const used = inventory.components.filter((item) => item.lifecycle?.actualUsed === true).length;
  const usedUnknown = inventory.components.filter((item) => item.kind === "skill" && item.lifecycle?.actualUsed == null).length;
  const lines = [`Scanned ${inventory.components.length} components`, `  Plugins: ${counts.plugin ?? 0}`, `  Skills:  ${counts.skill ?? 0}`, `  Analysis scope: ${inventory.analysisScope ?? "unknown"}`, `  Session-visible: ${visible}`, `  Actual-used: ${used} (unknown=${usedUnknown})`, `  State generated: ${inventory.generatedAt}`];
  return lines.join("\n");
}

export function formatAnalysis(analysis) {
  const counts = countBy(analysis.findings, "severity");
  const actionable = analysis.findings.filter((finding) => finding.severity !== "info");
  const informational = analysis.findings.filter((finding) => finding.severity === "info");
  const informationalTypes = countBy(informational, "type");
  const state = analysis.coverage.lifecycle ?? {};
  const unknownLifecycle = (state.unknownInstallation ?? 0) + (state.unknownEnabled ?? 0) + (state.unknownSessionVisibility ?? 0) + (state.unknownActualUsed ?? 0);
  const lines = [`Inventory: ${analysis.inventoryMode ?? "unknown"} (${analysis.inventoryGeneratedAt ?? "unknown time"})`, `Analysis scope: ${analysis.analysisScope ?? "unknown"}`, `Found ${analysis.findings.length} findings; actionable=${actionable.length}, informational=${informational.length}`, `  High:   ${counts.high ?? 0}`, `  Medium: ${counts.medium ?? 0}`, `  Info:   ${counts.info ?? 0}`, `Informational groups: ${Object.entries(informationalTypes).map(([name, count]) => `${name}=${count}`).join(", ") || "none"}`, `Coverage: ${analysis.coverage.totalSkills} Skills; ${analysis.coverage.missingDescription} missing descriptions, ${analysis.coverage.missingTriggers} without explicit triggers, ${analysis.coverage.missingTools} without explicit tools`, `Lifecycle: discovered=${state.discovered ?? 0}, installed=${state.installed ?? 0}, enabled=${state.enabled ?? 0}, session-visible=${state.sessionVisible ?? 0}, actual-used=${state.actualUsed ?? 0}, unknown-fields=${unknownLifecycle}`, `Metadata parse errors: ${analysis.coverage.metadataErrors ?? 0}`, `Declared risk inventory: ${Object.entries(analysis.riskInventory).map(([name, count]) => `${name}=${count}`).join(", ") || "none"}`];
  const listedFindings = analysis.actionableFindings ?? analysis.findings.filter((finding) => finding.severity !== "info");
  for (const check of analysis.requiredChecks ?? []) lines.push(`Required check: ${check.id}=${check.status} (pass=${check.passedSkills}, findings=${check.findingSkills}, unknown=${check.unknownSkills})${check.unknownSkills ? "; use --json for inspection limitations" : ""}`);
  for (const finding of listedFindings.slice(0, 20)) {
    lines.push(`- [${finding.severity}] ${finding.type}: ${finding.componentId ?? finding.components?.join(" <> ")}${finding.path ? ` (${finding.reason}: ${finding.path})` : ""}`);
  }
  if (listedFindings.length > 20 || analysis.findings.length > listedFindings.length) lines.push("- ... use --json for all findings");
  return lines.join("\n");
}

function formatPlanItem(item) {
  if (!item) return "none";
  return `${item.name} [${item.runtime}] (${item.score})${item.requiresApproval ? " [approval]" : ""}`;
}

export function formatPlan(plan) {
  const lines = [`Inventory: ${plan.inventoryMode ?? "unknown"} (${plan.inventoryGeneratedAt ?? "unknown time"})`, `Analysis scope: ${plan.analysisScope ?? "unknown"}`, `Task: ${plan.task}`, `Personal Method: ${plan.methodId ?? "none"}`, `Primary: ${formatPlanItem(plan.primary)}`, `Augment: ${plan.augment.length ? plan.augment.map(formatPlanItem).join(", ") : "none"}`, `Risks: ${plan.risks.length ? plan.risks.join(", ") : "none"}`, `Why: ${plan.explanation}`];
  if (!plan.primary && plan.noMatchHints?.length) lines.push(`Near matches: ${plan.noMatchHints.map((item) => `${item.name} (${item.reason})`).join(", ")}`);
  if (plan.correction) lines.push(`Personal correction: ${plan.correction}`);
  return lines.join("\n");
}
