import { lstat, mkdir, readFile, realpath, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { analyzeInventory } from "./analyzer.js";
import { listJsonFiles, readJson, skillAllowed, writeJson } from "./store.js";

const RUNTIMES = ["codex", "hermes", "claude", "pi", "opencode", "openclaw", "skywork"];
const OVERLAP_TYPES = new Set(["semantic_overlap", "duplicate_name", "duplicate_registration"]);
const DAY = 86_400_000;
const selectionKey = (runtime, id) => JSON.stringify([runtime, id]);
const skillRuntime = (inventory, skill) => inventory.runtime && inventory.runtime !== "all" ? inventory.runtime : skill.runtime;

function concreteRuntime(runtime) {
  if (!RUNTIMES.includes(runtime)) throw new Error("Slim apply/restore requires one concrete --runtime (not all).");
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number.`);
  return number;
}

// Deliberately dependency-free and approximate, not a model-specific tokenizer.
export function estimateTokens(text = "") {
  return Math.ceil(Buffer.byteLength(String(text), "utf8") / 4);
}

function usageEvidence(skill, inventory, receipts, now, unusedDays) {
  const observations = [];
  const observe = (date, source) => {
    const time = Date.parse(date);
    if (Number.isFinite(time) && time <= now) observations.push({ time, source });
  };
  if (skill.lifecycle?.actualUsed === true) observe(inventory.generatedAt, "actualUsed");
  for (const receipt of receipts) {
    // Remote receipts do not establish use of this machine's installation.
    if (receipt.provenance || receipt.runtime !== (skill.runtime ?? inventory.runtime)) continue;
    const ids = [receipt.plan?.primary, ...(receipt.plan?.augment ?? [])].map((entry) => typeof entry === "object" ? entry?.id : entry);
    if (!ids.includes(skill.id) || receipt.governance?.actualUsed === false) continue;
    // A retrospective match alone is not evidence of execution. Legacy receipts
    // with no attribution still provide a dated association with this Skill.
    if (receipt.execution?.attribution === "retrospective-resolution" && receipt.governance?.actualUsed !== true) continue;
    observe(receipt.createdAt, "receipt");
  }
  observations.sort((a, b) => b.time - a.time);
  const latest = observations[0];
  return {
    status: !latest ? "unknown" : latest.time >= now - unusedDays * DAY ? "used" : "unused",
    lastUsedAt: latest ? new Date(latest.time).toISOString() : null,
    evidence: latest?.source ?? null
  };
}

async function sizeEstimate(skill) {
  const descriptionTokens = estimateTokens(skill.description);
  if (skill.source && path.isAbsolute(skill.source)) {
    try {
      return { skillTokens: estimateTokens(await readFile(path.join(skill.source, "SKILL.md"), "utf8")), descriptionTokens, source: "SKILL.md" };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return { skillTokens: null, descriptionTokens, source: "description-only" };
}

export async function analyzeSlim(inventory, receipts = [], { maxTokens = 4000, unusedDays = 30, now = Date.now(), allowlists = {} } = {}) {
  maxTokens = positiveNumber(maxTokens, "--max-tokens");
  unusedDays = positiveNumber(unusedDays, "--unused-days");
  const components = inventory.components.filter((item) => item.kind === "skill" && item.lifecycle?.installed !== false);
  // Use the analyzer's exact-name/source and semantic comparisons, including
  // informational fallback findings, without making cross-runtime copies rivals.
  const runtimeGroups = new Map();
  for (const skill of components) {
    const runtime = skillRuntime(inventory, skill);
    if (!runtimeGroups.has(runtime)) runtimeGroups.set(runtime, []);
    runtimeGroups.get(runtime).push(skill);
  }
  const byComponent = new Map();
  for (const [runtime, group] of runtimeGroups) {
    const overlaps = analyzeInventory({ ...inventory, runtime, analysisScope: inventory.runtimeScopes?.[runtime] ?? inventory.analysisScope, components: group }).findings.filter((finding) => OVERLAP_TYPES.has(finding.type));
    for (const finding of overlaps) for (const id of finding.components) {
      const key = selectionKey(runtime, id);
      if (!byComponent.has(key)) byComponent.set(key, []);
      byComponent.get(key).push(finding);
    }
  }
  const skills = await Promise.all(components.map(async (skill) => {
    const runtime = skillRuntime(inventory, skill);
    const usage = usageEvidence({ ...skill, runtime }, inventory, receipts, now, unusedDays);
    const tokens = await sizeEstimate(skill);
    const related = byComponent.get(selectionKey(runtime, skill.id)) ?? [];
    const flags = [
      ...(usage.status === "unused" ? ["unused"] : []),
      ...(related.length ? ["overlapping"] : []),
      ...(Math.max(tokens.skillTokens ?? 0, tokens.descriptionTokens) > maxTokens ? ["oversized"] : [])
    ];
    return { id: skill.id, name: skill.name, runtime, source: skill.source, usage, tokens, flags, overlaps: related, suggested: false, reasons: [] };
  }));
  const ranked = [...skills].sort((a, b) =>
    ({ used: 0, unknown: 1, unused: 2 }[a.usage.status] - { used: 0, unknown: 1, unused: 2 }[b.usage.status]) ||
    Number(a.flags.includes("oversized")) - Number(b.flags.includes("oversized")) ||
    (a.tokens.skillTokens ?? a.tokens.descriptionTokens) - (b.tokens.skillTokens ?? b.tokens.descriptionTokens) || a.id.localeCompare(b.id));
  const kept = new Set();
  for (const skill of ranked) {
    if (Object.hasOwn(allowlists, skill.runtime)) {
      skill.suggested = skillAllowed(allowlists, skill.runtime, skill.name);
      skill.reasons.push(skill.suggested ? "Explicitly allowlisted." : "Outside the explicit allowlist.");
    } else if (skill.usage.status === "unused") {
      skill.reasons.push(`Last usage evidence is older than ${unusedDays} days; consider disabling.`);
    } else {
      const rival = skill.overlaps.flatMap((finding) => finding.components).find((id) => kept.has(selectionKey(skill.runtime, id)));
      skill.suggested = !rival;
      skill.reasons.push(rival ? `Overlaps retained Skill ${rival}; review before excluding.` : skill.usage.status === "used" ? "Retain: recent usage evidence." : "Retain: usage is unknown and no retained Skill covers this overlap.");
    }
    if (skill.flags.includes("oversized")) skill.reasons.push(`Exceeds ${maxTokens} estimated tokens; shorten the description or move detail into references.`);
    if (skill.suggested) kept.add(selectionKey(skill.runtime, skill.id));
  }
  return { schemaVersion: "1", runtime: inventory.runtime, dryRun: true, maxTokens, unusedDays, tokenEstimate: "ceil(UTF-8 bytes / 4)", skills, suggested: skills.filter((skill) => skill.suggested).map(({ id, name, runtime }) => ({ id, name, runtime })), note: "Conservative greedy suggestion, not a proof of equivalent capabilities. Unknown unique Skills are retained. Nothing is changed." };
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function privateRoots(runtime, { home = os.homedir(), cwd = process.cwd(), hermesHome = process.env.HERMES_HOME } = {}) {
  if (runtime === "hermes") return [path.resolve(hermesHome || path.join(home, ".hermes"), "skills")];
  if (runtime === "codex") return [path.join(home, ".codex", "skills")];
  if (runtime === "claude") return [path.join(home, ".claude", "skills"), path.join(cwd, ".claude", "skills")];
  return [];
}

async function movable(skill, roots) {
  if (skill.plugin || skill.pluginRoot || !skill.source || !path.isAbsolute(skill.source)) return false;
  const source = path.resolve(skill.source);
  if (!roots.includes(path.dirname(source))) return false;
  // Do not move links, shared aliases, nested packages, or a Skill that contains
  // another independently discovered Skill. Canonical spelling must match.
  try {
    return (await lstat(source)).isDirectory() && await realpath(source) === source && (await lstat(path.join(source, "SKILL.md"))).isFile();
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function journalDirectory(stateDir, runtime) { return path.join(stateDir, "slim", "moves", runtime); }

export async function planSlimApply(inventory, allowlists, options = {}) {
  const runtime = inventory.runtime;
  concreteRuntime(runtime);
  if (!Object.hasOwn(allowlists, runtime)) throw new Error("No allowlist exists for this runtime. Use `ownhow slim allow <name...>` first.");
  const roots = privateRoots(runtime, options);
  const changes = [];
  const unsupported = [];
  for (const skill of inventory.components.filter((item) => item.kind === "skill" && item.lifecycle?.installed !== false && !skillAllowed(allowlists, runtime, item.name))) {
    const nested = inventory.components.some((other) => other.kind === "skill" && other.id !== skill.id && other.source?.startsWith(`${skill.source}${path.sep}`));
    const shared = inventory.components.some((other) => other.kind === "skill" && skillAllowed(allowlists, runtime, other.name) && (other.canonicalSource ?? other.source) === (skill.canonicalSource ?? skill.source));
    if (nested || shared || !await movable(skill, roots)) {
      unsupported.push({ id: skill.id, name: skill.name, source: skill.source, enforcement: "unsupported", reason: "No safe private standalone directory move is available for this installation." });
      continue;
    }
    const from = path.resolve(skill.source);
    if (changes.some((change) => change.from === from)) continue;
    const id = randomUUID();
    changes.push({ id, name: skill.name, from, to: path.join(path.dirname(path.dirname(from)), ".ownhow-disabled", id), status: "pending" });
  }
  return { runtime, dryRun: true, allowlist: allowlists[runtime], enforcement: unsupported.length || !roots.length ? "unsupported" : "supported", changes, unsupported, instructions: "Resolve already honors this allowlist. Review runtime settings and expose only the listed names for unsupported installations. Restart or refresh the runtime after applying or restoring. No files are deleted." };
}

async function preflight(changes) {
  for (const change of changes) {
    if (!await exists(change.from)) throw new Error(`Source is missing: ${change.from}`);
    if (await exists(change.to)) throw new Error(`Refusing to overwrite existing path: ${change.to}`);
    if (await realpath(change.from) !== path.resolve(change.from)) throw new Error(`Refusing to move a symlink or aliased source: ${change.from}`);
    let parent = path.dirname(change.to);
    while (!await exists(parent)) parent = path.dirname(parent);
    if (await realpath(parent) !== path.resolve(parent)) throw new Error(`Refusing a symlink or aliased destination: ${parent}`);
  }
}

export async function applySlim(stateDir, plan, { write = false } = {}) {
  concreteRuntime(plan.runtime);
  if (!write || !plan.changes.length) return { ...plan, dryRun: !write };
  await preflight(plan.changes);
  for (const change of plan.changes) {
    const journal = path.join(journalDirectory(stateDir, plan.runtime), `${change.id}.json`);
    // Persist intent before moving so restore can recover interrupted applies.
    await writeJson(journal, { ...change, runtime: plan.runtime });
    await mkdir(path.dirname(change.to), { recursive: true });
    await rename(change.from, change.to);
    change.status = "disabled";
    await writeJson(journal, { ...change, runtime: plan.runtime });
  }
  return { ...plan, dryRun: false };
}

export async function restoreSlim(stateDir, runtime, { write = false } = {}) {
  concreteRuntime(runtime);
  const directory = journalDirectory(stateDir, runtime);
  const changes = [];
  const recovered = [];
  for (const file of await listJsonFiles(directory)) {
    const entry = await readJson(path.join(directory, file));
    if (entry.status === "restored") continue;
    const originalExists = await exists(entry.from);
    const disabledExists = await exists(entry.to);
    // The previous restore may have moved the directory and then stopped before
    // updating its journal. Keep that operation recoverable too.
    if (entry.status === "restoring" && originalExists && !disabledExists) {
      recovered.push({ ...entry, journal: path.join(directory, file) });
      continue;
    }
    // A pending entry with its original still present has not moved yet.
    if (entry.status === "pending" && originalExists && !disabledExists) continue;
    if (!disabledExists) throw new Error(`Disabled Skill is missing: ${entry.to}`);
    changes.push({ ...entry, from: entry.to, to: entry.from, journal: path.join(directory, file) });
  }
  await preflight(changes);
  if (write) {
    for (const entry of recovered) await writeJson(entry.journal, { ...entry, status: "restored" });
    for (const change of changes) {
      await writeJson(change.journal, { ...change, from: change.to, to: change.from, status: "restoring" });
      await mkdir(path.dirname(change.to), { recursive: true });
      await rename(change.from, change.to);
      await writeJson(change.journal, { ...change, from: change.to, to: change.from, status: "restored" });
    }
  }
  return { runtime, dryRun: !write, changes, recovered, note: "Restores moved directories only; the explicit resolver allowlist is retained. Use slim allow to select restored names." };
}

export function formatSlim(value) {
  if (value.skills) return [`Slim (${value.runtime}, dry run): ${value.suggested.length}/${value.skills.length} suggested`, ...value.skills.map((skill) => `${skill.suggested ? "keep" : "review"}\t${skill.name}\tusage=${skill.usage.status}\t${skill.flags.join(", ") || "no flags"}\n  ${skill.reasons.join(" ")}`)].join("\n");
  return [`Slim (${value.runtime}, ${value.dryRun ? "dry run" : "written"})`, `Enforcement: ${value.enforcement ?? "restore"}`, ...(value.allowlist ? [`Allowlist: ${value.allowlist.join(", ") || "(empty)"}`] : []), ...value.changes.map((change) => `${change.from} -> ${change.to}`), ...(value.unsupported ?? []).map((skill) => `unsupported\t${skill.name}: ${skill.reason}`), value.instructions ?? value.note].join("\n");
}
