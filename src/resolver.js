import { createHash } from "node:crypto";
import { riskSignals, riskHints, analysisComponents, sameSource } from "./analyzer.js";
import { matchingTokens, overlapScore, tokenize, normalizeText } from "./text.js";

const list = (value) => Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
function aliases(component) { return [component.name, component.plugin, ...list(component.metadata?.aliases), ...list(component.metadata?.metadata?.aliases)].filter(Boolean); }
function fieldScore(tokens, query) {
  if (!tokens.size || !query.size) return 0;
  return 0.7 * matchingTokens(tokens, query).length / query.size + 0.3 * overlapScore(tokens, query);
}
function candidate(component, task, query) {
  const fields = { description: tokenize(component.description), triggers: tokenize(list(component.triggers).join(" ")), name: tokenize(aliases(component).join(" ")), keywords: tokenize([...list(component.metadata?.keywords), ...list(component.metadata?.metadata?.keywords)].join(" ")) };
  const search = new Set(Object.values(fields).flatMap((tokens) => [...tokens]));
  const sharedTokens = matchingTokens(search, query);
  const exact = aliases(component).some((alias) => normalizeText(alias) === normalizeText(task));
  const excluded = list(component.excludes).some((phrase) => { const terms = tokenize(phrase); return terms.size && [...terms].every((term) => query.has(term)); });
  const weights = { description: 0.55, triggers: 0.3, name: 0.1, keywords: 0.05 };
  const active = Object.keys(fields).filter((key) => fields[key].size);
  const fieldScores = Object.fromEntries(active.map((key) => [key, fieldScore(fields[key], query)]));
  const score = exact ? 1 : active.reduce((sum, key) => sum + fieldScores[key] * weights[key], 0) / (active.reduce((sum, key) => sum + weights[key], 0) || 1);
  const qualifies = exact || (sharedTokens.length >= 2 && score >= 0.2);
  return { component, score: Number(score.toFixed(3)), fieldScores, sharedTokens, risks: riskSignals(component), riskHints: riskHints(component), reason: component.metadataError ? "metadata_error" : excluded ? "excluded_by_rule" : qualifies ? "matched" : "below_threshold" };
}
function planEntry(entry) {
  const hard = ["external_message", "destructive_write", "credential_or_payment"];
  return { id: entry.component.id, name: entry.component.name, runtime: entry.component.runtime ?? "unknown", plugin: entry.component.plugin ?? null, source: entry.component.source, digest: entry.component.digest ?? null, lifecycle: entry.component.lifecycle ?? null, score: entry.score, fieldScores: entry.fieldScores, sharedTokens: entry.sharedTokens, reason: entry.reason, risks: entry.risks, riskHints: entry.riskHints, requiresApproval: entry.risks.some((risk) => hard.includes(risk)) };
}
export function planDigest(plan) {
  const binding = { runtime: plan.runtime ?? "unknown", analysisScope: plan.analysisScope ?? "unknown", task: plan.task, methodId: plan.methodId ?? null, methodVersion: plan.methodVersion ?? null, correction: plan.correction ?? null, primary: plan.primary ?? null, augment: plan.augment ?? [], risks: plan.risks ?? [] };
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}
export function resolveTask(inventory, task, methods = []) {
  const query = tokenize(task);
  const candidates = analysisComponents(inventory).filter((component) => component.kind === "skill").map((component) => candidate(component, task, query)).sort((a, b) => b.score - a.score || a.component.id.localeCompare(b.component.id));
  const rankedMethods = methods.filter((entry) => !entry.disabled && (!entry.runtime || ["all", "unknown"].includes(entry.runtime) || !inventory.runtime || inventory.runtime === "all" || entry.runtime === inventory.runtime)).map((entry) => ({ entry, score: overlapScore(tokenize(entry.task), query) })).filter((item) => item.score >= 0.45).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  const ambiguousMethod = rankedMethods.length > 1 && rankedMethods[0].score === rankedMethods[1].score && rankedMethods[0].entry.correction !== rankedMethods[1].entry.correction;
  const method = ambiguousMethod ? null : rankedMethods[0]?.entry;
  const selected = [];
  for (const entry of candidates.filter((item) => item.reason === "matched")) {
    if (selected.some((previous) => sameSource(previous.component, entry.component) || (previous.component.digest && previous.component.digest === entry.component.digest && previous.component.name === entry.component.name))) { entry.reason = "duplicate_source"; continue; }
    selected.push(entry);
  }
  const primary = selected[0] ?? null;
  // Alternatives do not automatically become extra workflows. Augmentation
  // requires an explicit contract rather than semantic similarity alone.
  const augment = selected.slice(1).filter((entry) => primary && list(entry.component.metadata?.augments).includes(primary.component.name) && entry.component.runtime === primary.component.runtime);
  const used = [primary, ...augment].filter(Boolean);
  const excluded = candidates.filter((entry) => !used.includes(entry));
  const reason = primary ? "matched" : !candidates.length ? "no_candidates" : candidates.every((entry) => entry.reason === "metadata_error") ? "metadata_error" : "no_eligible_match";
  const plan = { schemaVersion: "0.3", runtime: inventory.runtime ?? "unknown", generatedAt: new Date().toISOString(), analysisScope: inventory.analysisScope ?? "unknown", task, methodId: method?.id ?? null, methodVersion: method?.version ?? null, methodReason: ambiguousMethod ? "ambiguous" : method ? "matched" : "no_match", primary: primary ? planEntry(primary) : null, augment: augment.map(planEntry), excluded: excluded.slice(0, 20).map(planEntry), candidateCount: candidates.length, reason, scoreGap: primary && selected[1] ? Number((primary.score - selected[1].score).toFixed(3)) : null, risks: [...new Set([...used.flatMap((entry) => entry.risks), ...(method?.risks ?? [])])], explanation: primary ? `Primary selected from ${candidates.length} candidates; shared terms: ${primary.sharedTokens.join(", ")}.` : reason === "no_candidates" ? "No Skill candidates were discovered. Check the runtime and source paths." : "No eligible Skill matched. Inspect excluded reasons and parsed metadata.", correction: method?.correction ?? null };
  plan.digest = planDigest(plan);
  plan.id = `plan-${plan.digest}`;
  return plan;
}
