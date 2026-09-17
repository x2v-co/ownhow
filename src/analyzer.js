import { matchingTokens, overlapScore, tokenize } from "./text.js";

const RISK_PATTERNS = [
  ["external_message", /\b(send|email|notify|message)\b|发送|通知|发信/iu],
  ["destructive_write", /\b(delete|remove|drop|overwrite|truncate)\b|删除|清理|覆盖/iu],
  ["publish_or_deploy", /\b(publish|deploy|release|push|merge)\b|发布|部署|上线|合并/iu],
  ["credential_or_payment", /\b(secret|credential|password|payment|billing)\b|密钥|密码|支付|账单/iu],
  ["filesystem_write", /\b(write|edit|modify|create|update)\b|写入|编辑|修改|创建|更新/iu]
];

// Text hints are diagnostic only. Approval advice requires declared effects.
export function riskSignals(component) {
  const declared = [...(component.sideEffects ?? []), ...(component.writes ?? [])];
  const text = declared.join(" ");
  return RISK_PATTERNS.filter(([name, pattern]) => declared.includes(name) || pattern.test(text)).map(([name]) => name);
}
export function riskHints(component) {
  return RISK_PATTERNS.filter(([, pattern]) => pattern.test(`${component.name} ${component.description}`)).map(([name]) => name);
}
export function analysisComponents(inventory) {
  return (inventory.components ?? []).filter((component) => {
    if (component.lifecycle?.enabled === false || component.lifecycle?.sessionVisible === false) return false;
    const scope = component.analysisScope ?? inventory.runtimeScopes?.[component.runtime] ?? inventory.analysisScope;
    return scope !== "session-visible" || component.lifecycle?.sessionVisible === true;
  });
}
export function sameSource(left, right) {
  return Boolean((left.canonicalSource || left.source) && (left.canonicalSource || left.source) === (right.canonicalSource || right.source));
}

export function analyzeInventory(inventory) {
  const components = analysisComponents(inventory).filter((component) => component.kind === "skill");
  const findings = [];
  const coverage = { totalSkills: components.length, missingDescription: 0, missingTriggers: 0, missingTools: 0, metadataErrors: 0 };
  const lifecycle = { discovered: 0, installed: 0, enabled: 0, sessionVisible: 0, unknownInstallation: 0, unknownEnabled: 0, unknownSessionVisibility: 0 };
  const riskInventory = {};
  const hintInventory = {};
  const tokens = components.map((component) => tokenize(`${component.name} ${component.description} ${(component.triggers ?? []).join(" ")}`));
  for (const component of components) {
    const state = component.lifecycle ?? {};
    for (const key of ["discovered", "installed", "enabled", "sessionVisible"]) lifecycle[key] += state[key] === true ? 1 : 0;
    for (const [key, field] of [["unknownInstallation", "installed"], ["unknownEnabled", "enabled"], ["unknownSessionVisibility", "sessionVisible"]]) lifecycle[key] += state[field] == null ? 1 : 0;
    if (component.metadataError) coverage.metadataErrors += 1;
    else {
      if (!component.description) coverage.missingDescription += 1;
      if (!component.triggers?.length) coverage.missingTriggers += 1;
      if (!component.tools?.length) coverage.missingTools += 1;
    }
    for (const risk of riskSignals(component)) riskInventory[risk] = (riskInventory[risk] ?? 0) + 1;
    for (const hint of riskHints(component)) hintInventory[hint] = (hintInventory[hint] ?? 0) + 1;
  }
  // Index candidates instead of repeatedly tokenizing every possible pair.
  const index = new Map();
  const pairs = new Set();
  components.forEach((component, i) => {
    const keys = [...tokens[i]].map((token) => `token:${token}`);
    keys.push(`name:${component.name.toLowerCase()}`);
    if (component.canonicalSource || component.source) keys.push(`source:${component.canonicalSource || component.source}`);
    for (const write of component.writes ?? []) keys.push(`write:${write}`);
    for (const key of keys) {
      for (const j of index.get(key) ?? []) pairs.add(`${j}:${i}`);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(i);
    }
  });
  for (const pair of pairs) {
    const [i, j] = pair.split(":").map(Number);
    const left = components[i], right = components[j];
    const crossRuntime = left.runtime && right.runtime && left.runtime !== right.runtime;
    const sameName = left.name.toLowerCase() === right.name.toLowerCase();
    const identical = sameSource(left, right) || (left.digest && left.digest === right.digest && sameName);
    const overlap = overlapScore(tokens[i], tokens[j]);
    const collision = (right.writes ?? []).some((write) => (left.writes ?? []).includes(write));
    if (crossRuntime && !identical && !sameName) continue;
    if (!sameName && !identical && !collision && overlap < 0.55) continue;
    const visibleTogether = !crossRuntime && Boolean(left.runtime) && left.runtime !== "unknown" && left.runtime !== "auto" && left.lifecycle?.sessionVisible === true && right.lifecycle?.sessionVisible === true;
    const type = crossRuntime ? "runtime_copy" : identical ? "duplicate_registration" : sameName ? "duplicate_name" : collision ? "write_collision" : "semantic_overlap";
    const severity = crossRuntime || identical ? "info" : visibleTogether && (sameName || collision) ? "high" : "medium";
    findings.push({ type, severity, components: [left.id, right.id], overlap: Number(overlap.toFixed(3)), sharedTokens: matchingTokens(tokens[i], tokens[j]), visibleTogether, writeCollision: collision,
      message: crossRuntime ? "Separate runtime installations; not evidence of concurrent execution." : identical ? "The same source is registered more than once." : collision ? "Declared write targets overlap; review operation semantics." : sameName ? "Names overlap; verify runtime precedence." : "Task descriptions overlap; routing ambiguity is not a proven behavioral conflict." });
  }
  findings.sort((a, b) => ({ high: 0, medium: 1, info: 2 }[a.severity] - { high: 0, medium: 1, info: 2 }[b.severity]) || a.components.join().localeCompare(b.components.join()));
  return { schemaVersion: "0.3", generatedAt: new Date().toISOString(), analysisScope: inventory.analysisScope ?? "unknown", runtimeScopes: inventory.runtimeScopes ?? {}, coverage: { ...coverage, lifecycle }, riskInventory, hintInventory, comparisons: pairs.size, findings };
}
