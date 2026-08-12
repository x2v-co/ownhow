import { matchingTokens, overlapScore, tokenize } from "./text.js";

const RISK_PATTERNS = [
  ["external_message", /\b(send|message|email|通知|发送|发信|评论|review)\b/i],
  ["destructive_write", /\b(delete|remove|drop|overwrite|truncate|删除|清理|覆盖)\b/i],
  ["publish_or_deploy", /\b(publish|deploy|release|push|merge|发布|部署|上线|合并)\b/i],
  ["credential_or_payment", /\b(token|secret|credential|password|payment|billing|密钥|密码|支付|账单)\b/i],
  ["filesystem_write", /\b(write|edit|modify|create|update|写入|编辑|修改|创建|更新)\b/i]
];

export function riskSignals(component) {
  const text = `${component.name} ${component.description} ${(component.sideEffects ?? []).join(" ")} ${(component.writes ?? []).join(" ")} ${component.text ?? ""}`;
  return RISK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function analyzeInventory(inventory) {
  const components = inventory.components.filter((component) => component.kind === "skill");
  const findings = [];
  const coverage = { totalSkills: components.length, missingDescription: 0, missingTriggers: 0, missingTools: 0 };
  const riskInventory = {};
  for (const component of components) {
    const risks = riskSignals(component);
    if (!component.description) coverage.missingDescription += 1;
    if (component.triggers.length === 0) coverage.missingTriggers += 1;
    if (component.tools.length === 0) coverage.missingTools += 1;
    for (const risk of risks) riskInventory[risk] = (riskInventory[risk] ?? 0) + 1;
  }
  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
    const left = components[leftIndex];
    const right = components[rightIndex];
    if (left.plugin && left.plugin === right.plugin) continue;
    const leftTokens = tokenize(`${left.name} ${left.description} ${(left.triggers ?? []).join(" ")}`);
    const rightTokens = tokenize(`${right.name} ${right.description} ${(right.triggers ?? []).join(" ")}`);
    const overlap = overlapScore(leftTokens, rightTokens);
    const shared = matchingTokens(leftTokens, rightTokens);
    const sameName = left.name.toLowerCase() === right.name.toLowerCase();
    const leftWrites = new Set(left.writes ?? []);
    const hasWriteCollision = (right.writes ?? []).some((write) => leftWrites.has(write));
    if (sameName || overlap >= 0.55 || hasWriteCollision) findings.push({ type: sameName ? "duplicate_name" : hasWriteCollision ? "write_collision" : "semantic_overlap", severity: sameName || hasWriteCollision ? "high" : "medium", components: [left.id, right.id], overlap: Number(overlap.toFixed(3)), sharedTokens: shared, message: sameName ? "Skills from different sources share the same name." : hasWriteCollision ? "Skills declare overlapping write targets." : "Skills from different sources may compete for the same task context." });
  }
  return { schemaVersion: "0.1", generatedAt: new Date().toISOString(), coverage, riskInventory, findings };
}
