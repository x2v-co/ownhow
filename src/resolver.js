import { riskSignals } from "./analyzer.js";
import { matchingTokens, overlapScore, slugify, tokenize } from "./text.js";

function searchTokens(component) { return tokenize([component.name, component.description, ...(component.triggers ?? []), ...(component.metadata?.keywords ?? [])].join(" ")); }
function scoreComponent(component, taskTokens) { const search = searchTokens(component); return Number((overlapScore(search, taskTokens) * 0.55 + overlapScore(tokenize((component.triggers ?? []).join(" ")), taskTokens) * 0.3 + overlapScore(tokenize(component.name), taskTokens) * 0.15).toFixed(3)); }
function planEntry(entry) { const hardRisks = ["external_message", "destructive_write", "credential_or_payment"]; return { id: entry.component.id, name: entry.component.name, source: entry.component.source, score: entry.score, sharedTokens: entry.sharedTokens, risks: entry.risks, requiresApproval: entry.risks.some((risk) => hardRisks.includes(risk)) }; }

export function resolveTask(inventory, task, methods = []) {
  const taskTokens = tokenize(task);
  const candidates = inventory.components.filter((component) => component.kind === "skill").map((component) => ({ component, score: scoreComponent(component, taskTokens), sharedTokens: matchingTokens(searchTokens(component), taskTokens), risks: riskSignals(component) })).sort((a, b) => b.score - a.score || a.component.id.localeCompare(b.component.id));
  const method = methods.find((entry) => overlapScore(tokenize(entry.task), taskTokens) >= 0.45);
  const selected = candidates.filter((entry) => entry.score >= 0.08);
  const primary = selected[0] ?? null;
  const augment = selected.slice(1).filter((entry) => entry.score >= Math.max(0.12, (primary?.score ?? 0) * 0.55));
  const excluded = candidates.filter((entry) => !primary || entry.component.id !== primary.component.id).filter((entry) => !augment.some((item) => item.component.id === entry.component.id));
  return { schemaVersion: "0.1", generatedAt: new Date().toISOString(), task, methodId: method?.id ?? `personal:${slugify(task)}`, primary: primary ? planEntry(primary) : null, augment: augment.map(planEntry), excluded: excluded.slice(0, 20).map(planEntry), risks: [...new Set([...selected.flatMap((entry) => entry.risks), ...(method?.risks ?? [])])], explanation: primary ? `Primary selected by deterministic overlap on ${primary.sharedTokens.join(", ") || "task context"}.` : "No Skill met the minimum deterministic match threshold.", correction: method?.correction ?? null };
}
