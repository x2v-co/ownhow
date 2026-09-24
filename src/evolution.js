import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./store.js";
import { slugify } from "./text.js";

export const GOVERNANCE_FIELDS = ["discovered", "matched", "loaded", "actualUsed", "followed", "reused", "verified"];
const GOVERNANCE_ALIASES = new Set(["used"]);
const booleanOrNull = (value, label) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean or null.`);
  return value;
};

// Governance evidence is deliberately a small, typed summary. It records what
// the Agent observed without copying task text, Skill bodies, or local paths.
export function normalizeGovernance(value = {}, defaults = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("governance must be an object.");
  const unsupported = Object.keys(value).filter((key) => !GOVERNANCE_FIELDS.includes(key) && !GOVERNANCE_ALIASES.has(key));
  if (unsupported.length) throw new Error(`governance has unsupported fields: ${unsupported.join(", ")}`);
  const actualUsed = Object.hasOwn(value, "actualUsed") ? value.actualUsed : Object.hasOwn(value, "used") ? value.used : undefined;
  const defaultActualUsed = Object.hasOwn(defaults, "actualUsed") ? defaults.actualUsed : defaults.used;
  return Object.fromEntries(GOVERNANCE_FIELDS.map((key) => [key, booleanOrNull(
    key === "actualUsed" ? (actualUsed === undefined ? defaultActualUsed : actualUsed) : Object.hasOwn(value, key) ? value[key] : defaults[key],
    `governance.${key}`
  )]));
}

export function createReceipt(task, outcome, correction, plan, context = {}) {
  const list = (value) => Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  const methodUse = context.methodUse ?? "unknown";
  const verifiedBy = context.verifiedBy ?? "unknown";
  const hasMethod = Boolean(plan.methodId);
  const methodUseKnown = methodUse === "loaded" || methodUse === "followed";
  const governance = normalizeGovernance(context.governance, {
    discovered: true,
    matched: Boolean(plan.primary || plan.methodId),
    loaded: hasMethod ? (methodUseKnown ? true : null) : false,
    actualUsed: hasMethod ? (methodUseKnown ? true : null) : false,
    followed: hasMethod ? (methodUse === "followed" ? true : methodUse === "loaded" ? false : null) : false,
    reused: hasMethod ? (methodUseKnown ? true : null) : false,
    verified: verifiedBy === "unknown" ? null : true
  });
  return {
    id: `receipt-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    task,
    outcome,
    correction: correction || null,
    runtime: context.runtime ?? "unknown",
    sampleKind: context.sampleKind ?? "unknown",
    execution: { planId: context.executionPlan ? plan.id : null, planDigest: context.executionPlan ? plan.digest : null, attribution: context.executionPlan ? "caller-supplied-plan" : "retrospective-resolution", methodUse, methodVersion: plan.methodVersion ?? null },
    governance,
    details: {
      summary: context.summary || null,
      evidence: list(context.evidence),
      artifacts: list(context.artifacts),
      blockers: list(context.blockers),
      confidence: context.confidence ?? "unknown",
      verifiedBy
    },
    plan: {
      methodId: plan.methodId,
      primary: plan.primary?.id ?? null,
      augment: plan.augment.map((item) => item.id),
      risks: plan.risks
    }
  };
}

export function createProposal(receipt) {
  if (!receipt.correction) throw new Error("Receipt has no correction to propose.");
  return {
    id: `proposal-${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: "proposed",
    createdAt: new Date().toISOString(),
    sourceReceiptId: receipt.id,
    task: receipt.task,
    runtime: receipt.runtime ?? "unknown",
    correction: receipt.correction,
    basePlan: receipt.plan,
    risks: receipt.plan.risks ?? [],
    review: {
      sourceSkillsWillChange: false,
      requiresExplicitApply: true,
      note: "Applying creates a local Personal Method overlay only."
    }
  };
}

export async function saveProposal(stateDir, proposal) {
  await writeJson(path.join(stateDir, "proposals", `${proposal.id}.json`), proposal);
}

export async function applyProposal(stateDir, proposalId) {
  if (!/^proposal-[a-zA-Z0-9-]+$/.test(proposalId)) throw new Error("Invalid proposal id");
  const proposalFile = path.join(stateDir, "proposals", `${proposalId}.json`);
  const proposal = await readJson(proposalFile);
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
  if (proposal.status === "applied") throw new Error(`Proposal already applied: ${proposalId}`);
  const id = `personal:${slugify(proposal.task)}`;
  const methodFile = path.join(stateDir, "methods", `${slugify(id)}.json`);
  const previous = await readJson(methodFile);
  const history = path.join(stateDir, "method-history", slugify(id));
  if (previous) await writeJson(path.join(history, `${previous.version}.json`), previous);
  const currentRevision = Math.max(previous?.revision ?? -1, Number(previous?.version?.split(".")[2] ?? -1));
  const method = {
    schemaVersion: "0.1",
    id,
    version: `0.1.${currentRevision + 1}`,
    revision: currentRevision + 1,
    previousVersion: previous?.version ?? null,
    runtime: proposal.runtime ?? "unknown",
    owner: "local-user",
    task: proposal.task,
    correction: proposal.correction,
    basePlan: proposal.basePlan,
    risks: proposal.risks,
    sourceProposalId: proposal.id,
    appliedAt: new Date().toISOString()
  };
  await writeJson(path.join(history, `${method.version}.json`), method);
  await writeJson(methodFile, method);
  proposal.status = "applied";
  proposal.appliedAt = method.appliedAt;
  await writeJson(proposalFile, proposal);
  return method;
}

export async function rollbackMethod(stateDir, methodId, version) {
  if (!methodId.startsWith("personal:") || !/^0\.1\.\d+$/.test(version)) throw new Error("Invalid method id or version");
  const history = path.join(stateDir, "method-history", slugify(methodId));
  const target = await readJson(path.join(history, `${version}.json`));
  const current = await readJson(path.join(stateDir, "methods", `${slugify(methodId)}.json`));
  if (!target || !current || target.id !== methodId || current.id !== methodId) throw new Error("Method version not found");
  const revision = (current.revision ?? Number(current.version.split(".")[2])) + 1;
  const restored = { ...target, version: `0.1.${revision}`, revision, previousVersion: current.version, restoredFrom: version, appliedAt: new Date().toISOString() };
  await writeJson(path.join(history, `${current.version}.json`), current);
  await writeJson(path.join(history, `${restored.version}.json`), restored);
  await writeJson(path.join(stateDir, "methods", `${slugify(methodId)}.json`), restored);
  return restored;
}
