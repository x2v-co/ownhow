import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./store.js";
import { slugify } from "./text.js";

export function createReceipt(task, outcome, correction, plan, context = {}) {
  const list = (value) => Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  return {
    id: `receipt-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    task,
    outcome,
    correction: correction || null,
    runtime: context.runtime ?? "unknown",
    details: {
      summary: context.summary || null,
      evidence: list(context.evidence),
      artifacts: list(context.artifacts),
      blockers: list(context.blockers),
      confidence: context.confidence ?? "unknown",
      verifiedBy: context.verifiedBy ?? "unknown"
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
  const proposalFile = path.join(stateDir, "proposals", `${proposalId}.json`);
  const proposal = await readJson(proposalFile);
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
  if (proposal.status === "applied") throw new Error(`Proposal already applied: ${proposalId}`);
  const method = {
    schemaVersion: "0.1",
    id: `personal:${slugify(proposal.task)}`,
    version: "0.1.0",
    owner: "local-user",
    task: proposal.task,
    correction: proposal.correction,
    basePlan: proposal.basePlan,
    risks: proposal.risks,
    sourceProposalId: proposal.id,
    appliedAt: new Date().toISOString()
  };
  await writeJson(path.join(stateDir, "methods", `${slugify(method.id)}.json`), method);
  proposal.status = "applied";
  proposal.appliedAt = method.appliedAt;
  await writeJson(proposalFile, proposal);
  return method;
}
