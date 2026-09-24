import { matchingTokens, overlapScore, tokenize } from "./text.js";

// These words occur in most Skill descriptions and do not provide useful
// evidence that two Skills should be compared. `text.js` already removes
// general language stop words; this smaller, domain-specific set prevents a
// large installation from creating a posting list (and therefore a quadratic
// candidate set) for words such as "skill", "task", and "review".
const ANALYSIS_STOP_WORDS = new Set([
  "skill", "plugin", "method", "agent", "agents", "task", "tasks", "workflow", "workflows",
  "review", "reviews", "code", "project", "projects", "repository", "repositories",
  "local", "general", "manage", "management", "govern", "governance", "run", "check",
  "技能", "插件", "方法", "代理", "任务", "工作流", "项目", "仓库", "本地", "检查", "治理", "管理", "执行"
]);

// A token that appears in too many components is not selective enough to be a
// useful semantic candidate. Exact indexes (name/source/write) are separate
// and are never subject to this guard, so exact comparisons remain complete.
function tokenPostingLimit(componentCount) {
  if (componentCount < 2) return 0;
  return Math.max(24, Math.min(96, Math.ceil(Math.sqrt(componentCount) * 4)));
}

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
  const lifecycle = { discovered: 0, installed: 0, enabled: 0, sessionVisible: 0, actualUsed: 0, unknownInstallation: 0, unknownEnabled: 0, unknownSessionVisibility: 0, unknownActualUsed: 0 };
  const riskInventory = {};
  const hintInventory = {};
  const tokens = components.map((component) => tokenize(`${component.name} ${component.description} ${(component.triggers ?? []).join(" ")}`));
  for (const component of components) {
    const state = component.lifecycle ?? {};
    for (const key of ["discovered", "installed", "enabled", "sessionVisible", "actualUsed"]) lifecycle[key] += state[key] === true ? 1 : 0;
    for (const [key, field] of [["unknownInstallation", "installed"], ["unknownEnabled", "enabled"], ["unknownSessionVisibility", "sessionVisible"], ["unknownActualUsed", "actualUsed"]]) lifecycle[key] += state[field] == null ? 1 : 0;
    if (component.metadataError) coverage.metadataErrors += 1;
    else {
      if (!component.description) coverage.missingDescription += 1;
      if (!component.triggers?.length) coverage.missingTriggers += 1;
      if (!component.tools?.length) coverage.missingTools += 1;
    }
    for (const risk of riskSignals(component)) riskInventory[risk] = (riskInventory[risk] ?? 0) + 1;
    for (const hint of riskHints(component)) hintInventory[hint] = (hintInventory[hint] ?? 0) + 1;
  }
  // Build exact and semantic indexes separately. Exact comparisons are part of
  // the analyzer contract and must remain complete even when a token is too
  // common to be useful for semantic candidate generation.
  const exactIndex = new Map();
  const tokenIndex = new Map();
  const pairs = new Set();
  const componentCount = components.length;
  const addPair = (left, right) => {
    if (left === right) return;
    const i = Math.min(left, right);
    const j = Math.max(left, right);
    // Numeric pair keys avoid allocating/splitting strings for every candidate.
    pairs.add(i * componentCount + j);
  };
  const addIndex = (index, key, value) => {
    const posting = index.get(key);
    if (posting) posting.push(value);
    else index.set(key, [value]);
  };
  components.forEach((component, i) => {
    const exactKeys = new Set([`name:${component.name.toLowerCase()}`]);
    if (component.canonicalSource || component.source) exactKeys.add(`source:${component.canonicalSource || component.source}`);
    for (const write of component.writes ?? []) exactKeys.add(`write:${write}`);
    for (const key of exactKeys) addIndex(exactIndex, key, i);
    for (const token of tokens[i]) {
      if (!ANALYSIS_STOP_WORDS.has(token)) addIndex(tokenIndex, token, i);
    }
  });
  for (const posting of exactIndex.values()) {
    for (let left = 0; left < posting.length; left += 1) {
      for (let right = left + 1; right < posting.length; right += 1) addPair(posting[left], posting[right]);
    }
  }
  const postingLimit = tokenPostingLimit(componentCount);
  for (const posting of tokenIndex.values()) {
    // High-frequency tokens are intentionally omitted from candidate
    // generation. They still appear in overlap diagnostics when another
    // selective token produced the pair, and exact keys above are unaffected.
    if (posting.length > postingLimit) continue;
    for (let left = 0; left < posting.length; left += 1) {
      for (let right = left + 1; right < posting.length; right += 1) addPair(posting[left], posting[right]);
    }
  }
  for (const pair of pairs) {
    const i = Math.floor(pair / componentCount);
    const j = pair % componentCount;
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
    // Semantic overlap is a routing hint until both components are known to be
    // visible in the same host session. Unknown/fallback lifecycle state must
    // not turn a discovered copy into an actionable conflict.
    const severity = crossRuntime || identical ? "info" : visibleTogether && (sameName || collision) ? "high" : visibleTogether ? "medium" : "info";
    findings.push({ type, severity, components: [left.id, right.id], overlap: Number(overlap.toFixed(3)), sharedTokens: matchingTokens(tokens[i], tokens[j]), visibleTogether, writeCollision: collision,
      message: crossRuntime ? "Separate runtime installations; not evidence of concurrent execution." : identical ? "The same source is registered more than once." : collision ? "Declared write targets overlap; review operation semantics." : sameName ? "Names overlap; verify runtime precedence." : "Task descriptions overlap; routing ambiguity is not a proven behavioral conflict." });
  }
  findings.sort((a, b) => ({ high: 0, medium: 1, info: 2 }[a.severity] - { high: 0, medium: 1, info: 2 }[b.severity]) || a.components.join().localeCompare(b.components.join()));
  const actionableFindings = findings.filter((finding) => finding.severity !== "info");
  const informationalFindings = findings.filter((finding) => finding.severity === "info");
  const findingCountsByType = {};
  const actionableCountsByType = {};
  const informationalCountsByType = {};
  for (const finding of findings) {
    findingCountsByType[finding.type] = (findingCountsByType[finding.type] ?? 0) + 1;
    if (finding.severity !== "info") actionableCountsByType[finding.type] = (actionableCountsByType[finding.type] ?? 0) + 1;
    else informationalCountsByType[finding.type] = (informationalCountsByType[finding.type] ?? 0) + 1;
  }
  // Keep `findings` as the complete, backwards-compatible list. Consumers
  // that render the default actionable view can use `actionableFindings`, while
  // the grouped counters make informational distribution noise explicit.
  const findingGroups = {
    actionable: { count: actionableFindings.length, byType: actionableCountsByType },
    informational: { count: informationalFindings.length, byType: informationalCountsByType },
    runtime_copy: { count: findingCountsByType.runtime_copy ?? 0 },
    duplicate_registration: { count: findingCountsByType.duplicate_registration ?? 0 }
  };
  return {
    schemaVersion: "0.3",
    generatedAt: new Date().toISOString(),
    analysisScope: inventory.analysisScope ?? "unknown",
    runtimeScopes: inventory.runtimeScopes ?? {},
    coverage: { ...coverage, lifecycle },
    riskInventory,
    hintInventory,
    comparisons: pairs.size,
    findings,
    actionableFindings,
    informationalFindings,
    findingCountsByType,
    findingGroups,
    findingSummary: { total: findings.length, actionable: actionableFindings.length, informational: informationalFindings.length }
  };
}
