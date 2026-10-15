#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { analyzeInventory } from "./analyzer.js";
import { permissionPolicy } from "./permission-checks.js";
import { rollbackMethod, applyProposal, createProposal, createReceipt, saveProposal } from "./evolution.js";
import { formatAnalysis, formatInventory, formatPlan } from "./format.js";
import { acceptInboxEntry, createReceiptCapsule, importReceiptCapsule, rejectInboxEntry } from "./receipt-bundle.js";
import { planDigest, resolveTask } from "./resolver.js";
import { upgrade } from "./upgrade.js";
import { runtimeRoots, scanRoots, scanRuntime } from "./scanner.js";
import { loadSessionManifest, summarizeLifecycle } from "./session-manifest.js";
import { appendReceipt, readJson, writeJson, loadInbox, loadInboxEntry, loadInventory, loadMethods, loadReceipts, loadSkillAllowlists, updateSkillAllowlist, saveInventory, stateDirectory } from "./store.js";
import { analyzeSlim, applySlim, formatSlim, planSlimApply, restoreSlim } from "./slim.js";
import { configureTelemetry, disableTelemetry, exportTelemetry, purgeTelemetry, recordTelemetryEvent, sendTelemetry, telemetryStatus } from "./telemetry.js";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  const listKeys = new Set(["evidence", "artifact", "blocker", "permission-check", "permission-allow-skill"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const equals = value.indexOf("=");
    const key = value.slice(2, equals < 0 ? undefined : equals);
    if (equals >= 0) {
      const inline = value.slice(equals + 1);
      if (listKeys.has(key)) options[key] = [...(options[key] ?? []), inline];
      else options[key] = inline;
      continue;
    }
    if (["json", "help", "cached", "fast", "reexport-imported", "apply", "write", "check", "auto", "enable-auto", "disable-auto", "snooze", "recover"].includes(key)) { options[key] = true; continue; }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    index += 1;
    if (key === "root") options.root = [...(options.root ?? []), next];
    else if (listKeys.has(key)) options[key] = [...(options[key] ?? []), next];
    else options[key] = next;
  }
  return { positional, options };
}

function help() {
  return `OwnHow MVP - local governance for personal AI methods

Usage:
  ownhow scan [--runtime codex|hermes|claude|pi|opencode|openclaw|skywork|all] [--root PATH] [--state PATH] [--json]
  ownhow analyze [--runtime codex|hermes|claude|pi|opencode|openclaw|skywork|all] [--root PATH] [--cached|--fast] [--state PATH] [--json]
  ownhow resolve <task> [--runtime codex|hermes|claude|pi|opencode|openclaw|skywork|all] [--root PATH] [--cached|--fast] [--state PATH] [--json]
  ownhow slim [--runtime RUNTIME] [--max-tokens N] [--unused-days D] [--json]
  ownhow slim allow|deny <name...> --runtime RUNTIME [--state PATH] [--json]
  ownhow slim list [--runtime RUNTIME] [--state PATH] [--json]
  ownhow slim apply|restore --runtime RUNTIME [--write] [--state PATH] [--json]
  ownhow record <task> --outcome success|failure [--correction TEXT] [--summary TEXT] [--evidence TEXT] [--artifact PATH] [--blocker TEXT] [--confidence low|medium|high] [--verified-by user|agent|automated|unknown] [--governance JSON] [--runtime codex|hermes|claude|pi|opencode|openclaw|skywork|all] [--root PATH] [--cached|--fast] [--state PATH] [--json]
  ownhow export --receipt latest|ID --agent-id ID [--source local|imported|all] [--reexport-imported] [--protocol v1|v2] [--runtime codex|hermes|claude|pi|opencode|openclaw|skywork|all] [--state PATH] [--json]
  ownhow import <capsule|-> [--state PATH] [--json]
  ownhow inbox [list|show|accept|reject] [import-id] [--state PATH] [--json]
  ownhow propose [--receipt latest|ID] [--state PATH] [--json]
  ownhow apply <proposal-id> [--state PATH] [--json]
  ownhow status [--state PATH] [--json]
  ownhow doctor --runtime RUNTIME [--root PATH] [--json]
  ownhow methods [--state PATH] [--json]
  ownhow rollback <method-id> --version VERSION [--state PATH] [--json]
  ownhow upgrade --check [--version VERSION|--notice NOTICE] [--install-dir PATH] [--skill-dir PATH] [--json]
  ownhow upgrade --apply [--version VERSION|--notice NOTICE] [--install-dir PATH] [--skill-dir PATH] [--json]
  ownhow upgrade --enable-auto|--disable-auto [--install-dir PATH] [--skill-dir PATH] [--json]
  ownhow upgrade --auto [--notice NOTICE] [--json]
  ownhow upgrade --snooze --version VERSION|--notice NOTICE [--json]
  ownhow upgrade --recover [--json]
  ownhow telemetry status [--state PATH] [--json]
  ownhow telemetry enable [--mode local|remote] [--endpoint HTTPS_URL] [--state PATH] [--json]
  ownhow telemetry disable [--state PATH] [--json]
  ownhow telemetry export [--state PATH] [--json]
  ownhow telemetry purge [--state PATH] [--json]
  ownhow telemetry send [--state PATH] [--json]

Resolve: --save-plan PATH writes a reviewable execution plan (opt-in).
Record: --plan PATH binds the actual plan; --method-use loaded|followed|unknown
        --sample-kind business|demo|workflow-test|unknown labels evidence.
Permission risks (analyze): --permission-checks off|warn|block (default: warn)
  --permission-check ID=MODE overrides one check (repeatable).
  --permission-allow-skill ID skips permission findings for an exact Skill ID (repeatable).
  OWNHOW_PERMISSION_CHECKS accepts a mode or comma-separated ID=MODE assignments.
  Findings in block mode make analyze exit 1. These options do not change approvals.
Scans: --session-manifest PATH reads a host supplied manifest (legacy {runtime, skillFiles} or schema v1 {runtime, skills}).

Analyze and resolve use the live installation by default and do not write state.
Use --fast after an explicit scan to reuse a matching snapshot for up to five minutes; it falls back to a live read when the snapshot is missing or stale.
Slim is read-only unless allow/deny edits the local selection or apply/restore uses --write.
Slim never deletes files. Upgrade can replace explicitly selected OwnHow installations.`;
}

function output(value, json, formatter = null) { process.stdout.write(`${json || !formatter ? JSON.stringify(value, null, 2) : formatter(value)}\n`); }
function requireTask(parts) { const task = parts.join(" ").trim(); if (!task) throw new Error("Task is required."); return task; }
async function recordTelemetrySafely(stateDir, event) {
  try { await recordTelemetryEvent(stateDir, event); } catch { /* telemetry must never block the primary command */ }
}
function runtimeFor(options) {
  const runtime = options.runtime ?? process.env.OWNHOW_RUNTIME ?? (options.root ? "all" : null);
  if (!runtime) throw new Error("Select --runtime explicitly (or set OWNHOW_RUNTIME). Use all only for cross-runtime comparison.");
  if (!["codex", "hermes", "claude", "pi", "opencode", "openclaw", "skywork", "all"].includes(runtime)) throw new Error("--runtime must be codex, hermes, claude, pi, opencode, openclaw, skywork, or all.");
  return runtime;
}
async function rootsFor(options) { return options.root?.map((root) => path.resolve(root)) ?? runtimeRoots({ runtime: runtimeFor(options) }); }
function sourceRuntimeFor(options) { return options.root && runtimeFor(options) !== "all" ? runtimeFor(options) : "auto"; }
async function liveInventory(options) {
  if (options["session-manifest"]) {
    let manifest;
    try { manifest = await loadSessionManifest(options["session-manifest"], { runtime: runtimeFor(options) }); }
    catch (error) { throw new Error(`Session manifest must match --runtime and contain valid entries: ${error.message}`); }
    return scanRoots({ roots: [], runtime: manifest.runtime, runtimeState: {
      authoritative: true,
      skillFiles: manifest.skillFiles,
      syntheticSkills: manifest.syntheticSkills,
      activeSkillNames: manifest.activeSkillNames.length ? new Set(manifest.activeSkillNames) : null,
      actualUsedSkillNames: manifest.actualUsedSkillNames ? new Set(manifest.actualUsedSkillNames) : null,
      plugins: manifest.plugins
    } });
  }
  const inventory = options.root ? await scanRoots({ roots: await rootsFor(options), runtime: sourceRuntimeFor(options) }) : await scanRuntime({ runtime: runtimeFor(options) });
  return { ...inventory, runtime: runtimeFor(options) };
}
async function inventoryFor(options, stateDir) {
  if (options.fast && options.cached) throw new Error("--fast cannot be combined with --cached.");
  if (options.fast && (options["session-manifest"] || options.root)) throw new Error("--fast cannot be combined with --root or --session-manifest; use --cached after an explicit scan.");
  if (options.fast) {
    const cached = await loadInventory(stateDir).catch(() => null);
    const runtime = runtimeFor(options);
    const ttl = Number(process.env.OWNHOW_FAST_TTL_MS ?? 5 * 60 * 1000);
    const generated = cached?.generatedAt ? Date.parse(cached.generatedAt) : NaN;
    if (cached && cached.runtime === runtime && Number.isFinite(generated) && Date.now() - generated >= 0 && Date.now() - generated <= (Number.isFinite(ttl) && ttl > 0 ? ttl : 5 * 60 * 1000)) return cached;
  }
  if (!options.cached) return liveInventory(options);
  if (options["session-manifest"] || options.root) throw new Error("--cached cannot be combined with --root or --session-manifest; rescan the requested sources instead.");
  const inventory = await loadInventory(stateDir);
  const runtime = runtimeFor(options);
  if (inventory.runtime !== runtime) throw new Error("Cached inventory runtime does not match --runtime. Run scan again for the selected runtime.");
  return inventory;
}
async function capsuleInput(positional) {
  if (positional.length !== 1) throw new Error("A single receipt capsule or - for stdin is required.");
  if (positional[0] !== "-") return positional[0];
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function inboxSummary(entry) {
  return {
    id: entry.id,
    status: entry.status,
    importedAt: entry.importedAt,
    source: entry.bundle.source,
    task: entry.bundle.receipt.task,
    outcome: entry.bundle.receipt.outcome,
    correction: entry.bundle.receipt.correction,
    details: entry.bundle.receipt.details ?? null,
    warnings: entry.warnings,
    sourceAuthenticated: entry.sourceAuthenticated ?? false,
    acceptedReceiptId: entry.acceptedReceiptId ?? null
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h") { process.stdout.write(`${help()}\n`); return; }
  const { positional, options } = parseArgs(rest);
  if (!command || command === "help" || options.help) { process.stdout.write(`${help()}\n`); return; }
  const stateDir = stateDirectory(options.state);

  if (command === "slim") {
    const [action, ...names] = positional;
    if (options.write !== undefined && options.write !== true) throw new Error("--write is a boolean flag; pass it without a value.");
    if (options.write && !["apply", "restore"].includes(action)) throw new Error("--write is only supported by slim apply/restore.");
    if (action === "allow" || action === "deny") {
      output(await updateSkillAllowlist(stateDir, runtimeFor(options), action, names), options.json,
        (value) => `Allowlist (${value.runtime}): ${value.allowlist.join(", ") || "(empty; no Skills selected)"}`);
      return;
    }
    if (action && !["list", "apply", "restore"].includes(action)) throw new Error("Slim action must be allow, deny, list, apply, or restore. Deletion is not supported.");
    if (names.length) throw new Error(`Unexpected arguments for slim ${action ?? "analysis"}.`);
    if (action === "list") {
      const allowlists = await loadSkillAllowlists(stateDir);
      const runtime = options.runtime || process.env.OWNHOW_RUNTIME ? runtimeFor(options) : "all";
      const selected = runtime === "all" ? allowlists : Object.hasOwn(allowlists, runtime) ? { [runtime]: allowlists[runtime] } : {};
      output({ allowlists: selected }, options.json, (value) => Object.entries(value.allowlists).map(([name, list]) => `${name}: ${list.join(", ") || "(empty; no Skills selected)"}`).join("\n") || "No allowlist exists; selection is unrestricted.");
      return;
    }
    if (action === "restore") {
      output(await restoreSlim(stateDir, runtimeFor(options), { write: options.write === true }), options.json, formatSlim);
      return;
    }
    if (action === "apply" && (options.cached || options.fast || options["session-manifest"])) throw new Error("Slim apply requires a live filesystem scan; cached/fast/session-manifest inventories are not supported.");
    const inventory = await inventoryFor(options, stateDir);
    const allowlists = await loadSkillAllowlists(stateDir);
    if (action === "apply") {
      const plan = await planSlimApply(inventory, allowlists);
      output(await applySlim(stateDir, plan, { write: options.write === true }), options.json, formatSlim);
    } else {
      output(await analyzeSlim(inventory, await loadReceipts(stateDir), { maxTokens: options["max-tokens"], unusedDays: options["unused-days"], allowlists }), options.json, formatSlim);
    }
    return;
  }

  if (command === "telemetry") {
    const [action] = positional;
    if (!action || action === "status") {
      output(await telemetryStatus(stateDir), options.json, (value) => `Mode: ${value.mode}\nEvents: ${value.events}\nPending: ${value.pendingEvents}\nData: ${value.dataPolicy}`);
      return;
    }
    if (action === "enable") {
      const config = await configureTelemetry(stateDir, { mode: options.mode ?? "local", endpoint: options.endpoint ?? null });
      output(config, options.json, (value) => `Telemetry enabled (${value.mode})${value.endpoint ? `\nEndpoint: ${value.endpoint}` : ""}`);
      return;
    }
    if (action === "disable") {
      const config = await disableTelemetry(stateDir);
      output(config, options.json, () => "Telemetry disabled. Existing local events were retained.");
      return;
    }
    if (action === "export") {
      output(await exportTelemetry(stateDir), options.json);
      return;
    }
    if (action === "purge") {
      output(await purgeTelemetry(stateDir), options.json, (value) => `Telemetry events purged. Remaining: ${value.events}`);
      return;
    }
    if (action === "send") {
      const result = await sendTelemetry(stateDir);
      output(result, options.json, (value) => `Sent: ${value.sent}\nPending: ${value.pending}`);
      return;
    }
    throw new Error("Telemetry action must be status, enable, disable, export, purge, or send.");
  }

  if (command === "scan") {
    const inventory = await liveInventory(options);
    await saveInventory(stateDir, inventory);
    output(inventory, options.json, formatInventory);
    return;
  }
  if (command === "analyze") {
    const startedAt = Date.now();
    const permissionOptions = { mode: options["permission-checks"] ?? process.env.OWNHOW_PERMISSION_CHECKS ?? "warn", overrides: options["permission-check"] ?? [], allowSkills: options["permission-allow-skill"] ?? [] };
    permissionPolicy(permissionOptions);
    const inventory = await inventoryFor(options, stateDir);
    const analysis = { ...analyzeInventory(inventory, permissionOptions), inventoryMode: options.cached ? "cached" : options.fast ? "fast" : "live", inventoryGeneratedAt: inventory.generatedAt, inventoryAnalysisScope: inventory.analysisScope ?? "unknown" };
    await recordTelemetrySafely(stateDir, {
      type: "analyze", runtime: inventory.runtime ?? runtimeFor(options), scope: inventory.analysisScope,
      cache: analysis.inventoryMode, latencyMs: Date.now() - startedAt,
      skillCount: analysis.coverage?.totalSkills, findingCount: analysis.findings?.length,
      actionableFindingCount: analysis.actionableFindings?.length
    });
    output(analysis, options.json, formatAnalysis);
    if (analysis.permissionBlocked) process.exitCode = 1;
    return;
  }
  if (command === "resolve" || command === "record") {
    const startedAt = Date.now();
    const task = requireTask(positional);
    if (options.plan && command !== "record") throw new Error("--plan is only supported by record; resolve creates a new plan.");
    const suppliedPlan = options.plan ? await readJson(path.resolve(options.plan)) : null;
    if (options.plan && !suppliedPlan) throw new Error("Saved plan not found. Resolve and save the execution plan first.");
    if (suppliedPlan && (suppliedPlan.schemaVersion !== "0.3" || !Array.isArray(suppliedPlan.augment) || !Array.isArray(suppliedPlan.risks))) throw new Error("Invalid saved execution plan.");
    if (suppliedPlan && suppliedPlan.runtime !== runtimeFor(options)) throw new Error("Saved plan runtime does not match --runtime.");
    const inventory = suppliedPlan ? null : await inventoryFor(options, stateDir);
    const plan = suppliedPlan ?? { ...resolveTask(inventory, task, await loadMethods(stateDir), { allowlists: await loadSkillAllowlists(stateDir) }), inventoryMode: options.cached ? "cached" : options.fast ? "fast" : "live", inventoryGeneratedAt: inventory.generatedAt, inventoryAnalysisScope: inventory.analysisScope ?? "unknown" };
    if (suppliedPlan && (plan.task !== task || plan.digest !== planDigest(plan) || plan.id !== `plan-${plan.digest}`)) throw new Error("Plan task or digest does not match. Regenerate and review the execution plan.");
    if (command === "resolve") {
      if (options["save-plan"]) await writeJson(path.resolve(options["save-plan"]), plan);
      await recordTelemetrySafely(stateDir, {
        type: "resolve", runtime: plan.runtime ?? runtimeFor(options), scope: plan.analysisScope,
        result: plan.primary ? "matched" : "no_match", cache: plan.inventoryMode,
        latencyMs: Date.now() - startedAt, candidateCount: plan.candidateCount,
        methodUsed: Boolean(plan.methodId)
      });
      output(plan, options.json, formatPlan); return;
    }
    const sampleKind = options["sample-kind"] ?? "unknown";
    const methodUse = options["method-use"] ?? "unknown";
    if (!["business", "demo", "workflow-test", "unknown"].includes(sampleKind)) throw new Error("Invalid --sample-kind");
    if (!["loaded", "followed", "unknown"].includes(methodUse)) throw new Error("Invalid --method-use");
    if (methodUse !== "unknown" && (!suppliedPlan || !plan.methodId)) throw new Error("--method-use requires a saved plan with a Personal Method");
    if (!['success', 'failure'].includes(options.outcome)) throw new Error("--outcome must be success or failure.");
    const confidence = options.confidence ?? "unknown";
    const verifiedBy = options["verified-by"] ?? "unknown";
    if (!["low", "medium", "high", "unknown"].includes(confidence)) throw new Error("--confidence must be low, medium, high, or unknown.");
    if (!["user", "agent", "automated", "unknown"].includes(verifiedBy)) throw new Error("--verified-by must be user, agent, automated, or unknown.");
    let governance;
    if (options.governance !== undefined) {
      try { governance = JSON.parse(options.governance); } catch { throw new Error("--governance must be valid JSON."); }
    }
    const receipt = createReceipt(task, options.outcome, options.correction, plan, {
      runtime: plan.runtime ?? runtimeFor(options),
      sampleKind, methodUse, executionPlan: Boolean(suppliedPlan),
      summary: options.summary,
      evidence: options.evidence,
      artifacts: options.artifact,
      blockers: options.blocker,
      confidence,
      verifiedBy,
      governance
    });
    await appendReceipt(stateDir, receipt);
    await recordTelemetrySafely(stateDir, {
      type: "record", runtime: receipt.runtime ?? runtimeFor(options), result: receipt.outcome,
      latencyMs: Date.now() - startedAt, methodUsed: Boolean(plan.methodId),
      correctionProvided: Boolean(receipt.correction), verifiedBy
    });
    output(receipt, options.json, (value) => `Recorded ${value.id}\nOutcome: ${value.outcome}\nCorrection: ${value.correction ?? "none"}`);
    return;
  }
  if (command === "export") {
    const receipts = await loadReceipts(stateDir);
    const requested = options.receipt ?? "latest";
    const source = options.source ?? "local";
    if (!["local", "imported", "all"].includes(source)) throw new Error("--source must be local, imported, or all.");
    const requestedRuntime = options.runtime && options.runtime !== "all" ? runtimeFor(options) : null;
    const eligible = receipts.filter((item) => (source === "all" || (source === "imported" ? Boolean(item.provenance) : !item.provenance))
      && (!requestedRuntime || item.runtime === requestedRuntime));
    const receipt = requested === "latest" ? eligible.at(-1) : receipts.find((item) => item.id === requested);
    if (!receipt) throw new Error("No matching receipt found.");
    if (!options["agent-id"]) throw new Error("--agent-id is required.");
    if (requestedRuntime && receipt.runtime !== requestedRuntime) throw new Error(`Receipt runtime is ${receipt.runtime ?? "unknown"}, not ${requestedRuntime}.`);
    if (receipt.provenance && !(source === "imported" && options["reexport-imported"] === true)) {
      throw new Error("Refusing to re-export an imported Receipt. Use --source imported --reexport-imported explicitly.");
    }
    const protocol = options.protocol ?? "v2";
    if (!["v1", "v2"].includes(protocol)) throw new Error("--protocol must be v1 or v2.");
    const exported = createReceiptCapsule(receipt, { agentId: options["agent-id"], runtime: options.runtime ?? receipt.runtime ?? "unknown", protocolVersion: Number(protocol.slice(1)) });
    output(exported, options.json, (value) => value.capsule);
    return;
  }
  if (command === "import") {
    const imported = await importReceiptCapsule(stateDir, await capsuleInput(positional));
    output({ ...inboxSummary(imported.entry), duplicate: imported.duplicate }, options.json,
      (value) => `${value.duplicate ? "Already imported" : "Imported"} ${value.id} as ${value.status}\nSource: ${value.source.agentId} (${value.source.runtime})\nReview with: ownhow inbox show ${value.id}`);
    return;
  }
  if (command === "inbox") {
    const [action, entryId, ...extra] = positional;
    if (!action || (action === "list" && !entryId && !extra.length)) {
      const entries = (await loadInbox(stateDir)).map(inboxSummary).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
      output(entries, options.json, (values) => values.length
        ? values.map((value) => `${value.id}\t${value.status}\t${value.source.agentId}\t${value.outcome}\t${value.task}`).join("\n")
        : "Inbox is empty.");
      return;
    }
    if (!entryId || extra.length) throw new Error(`ownhow inbox ${action} requires exactly one import id.`);
    if (action === "show") {
      if (!/^import-[a-f0-9]{16,64}$/.test(entryId)) throw new Error("Invalid Inbox entry id.");
      const entry = await loadInboxEntry(stateDir, entryId);
      if (!entry) throw new Error(`Inbox entry not found: ${entryId}`);
      output(inboxSummary(entry), options.json, (value) => `Import: ${value.id}\nStatus: ${value.status}\nSource: ${value.source.agentId} (${value.source.runtime}, unauthenticated)\nTask: ${value.task}\nOutcome: ${value.outcome}\nCorrection: ${value.correction ?? "none"}\nSummary: ${value.details?.summary ?? "none"}\nEvidence: ${value.details?.evidence?.join(" | ") || "none"}\nArtifacts: ${value.details?.artifacts?.join(" | ") || "none"}\nBlockers: ${value.details?.blockers?.join(" | ") || "none"}\nConfidence: ${value.details?.confidence ?? "unknown"}\nVerified by: ${value.details?.verifiedBy ?? "unknown"}\nWarnings: ${value.warnings.join(" ")}`);
      return;
    }
    if (action === "accept") {
      const accepted = await acceptInboxEntry(stateDir, entryId);
      output({ ...inboxSummary(accepted.entry), receiptId: accepted.receipt?.id ?? accepted.entry.acceptedReceiptId, duplicate: accepted.duplicate }, options.json,
        (value) => `${value.duplicate ? "Already accepted" : "Accepted"} ${value.id}\nReceipt: ${value.receiptId}`);
      return;
    }
    if (action === "reject") {
      const rejected = await rejectInboxEntry(stateDir, entryId);
      output({ ...inboxSummary(rejected.entry), duplicate: rejected.duplicate }, options.json,
        (value) => `${value.duplicate ? "Already rejected" : "Rejected"} ${value.id}`);
      return;
    }
    throw new Error("Inbox action must be show, accept, or reject.");
  }
  if (command === "propose") {
    const receipts = await loadReceipts(stateDir);
    const requested = options.receipt ?? "latest";
    const receipt = requested === "latest" ? [...receipts].reverse().find((item) => item.correction) : receipts.find((item) => item.id === requested);
    if (!receipt) throw new Error("No matching receipt with a correction found.");
    const proposal = createProposal(receipt);
    await saveProposal(stateDir, proposal);
    output(proposal, options.json, (value) => `Proposed ${value.id}\nTask: ${value.task}\nCorrection: ${value.correction}\nApply explicitly with: ownhow apply ${value.id}`);
    return;
  }
  if (command === "apply") {
    const proposalId = positional[0];
    if (!proposalId) throw new Error("Proposal id is required.");
    const method = await applyProposal(stateDir, proposalId);
    output(method, options.json, (value) => `Applied ${value.id}@${value.version}\nCorrection: ${value.correction}\nInstalled Skills were not changed.`);
    return;
  }
  if (command === "doctor") {
    const startedAt = Date.now();
    const inventory = await liveInventory(options);
    const metadata = await readJson(new URL("../package.json", import.meta.url));
    const skills = inventory.components.filter((item) => item.kind === "skill");
    const lifecycle = summarizeLifecycle(inventory.components);
    const report = { cliVersion: metadata.version, nodeVersion: process.version, nodePath: process.execPath, cliPath: process.argv[1], runtime: runtimeFor(options), scope: inventory.analysisScope, authoritative: inventory.authoritative === true, roots: inventory.roots, lifecycle, ownhowComponents: inventory.components.filter((item) => item.name.includes("ownhow") || item.plugin === "ownhow" || item.name === "govern-personal-methods").map((item) => ({ name: item.name, version: item.version, source: item.source, lifecycle: item.lifecycle })), metadataErrors: skills.filter((item) => item.metadataError).map((item) => ({ source: item.source, error: item.metadataError })), note: inventory.authoritative ? "Using host-reported or adapter-qualified visibility." : "File discovery only; installed, enabled and current-session visibility are unknown." };
    await recordTelemetrySafely(stateDir, {
      type: "doctor", runtime: report.runtime, scope: report.scope, result: report.metadataErrors.length ? "failure" : "success",
      latencyMs: Date.now() - startedAt, skillCount: skills.length, findingCount: report.metadataErrors.length
    });
    output(report, options.json);
    return;
  }
  if (command === "methods") { output(await loadMethods(stateDir), options.json); return; }
  if (command === "rollback") {
    if (!positional[0] || !options.version) throw new Error("rollback requires a method id and --version");
    output(await rollbackMethod(stateDir, positional[0], options.version), options.json); return;
  }
  if (command === "upgrade") {
    const startedAt = Date.now();
    const result = await upgrade(options, stateDir);
    await recordTelemetrySafely(stateDir, { type: "upgrade", result: "success", latencyMs: Date.now() - startedAt });
    output(result, options.json, (value) => `${value.status}: ${value.currentVersion ?? value.cliVersion ?? "unknown"}${value.targetVersion ? ` -> ${value.targetVersion}` : ""}${value.sessionReloadRequired ? "\nStart a new Agent session to load the updated Skill." : ""}`);
    return;
  }
  if (command === "status") {
    const inventory = await loadInventory(stateDir).catch(() => null);
    const receipts = await loadReceipts(stateDir);
    const methods = await loadMethods(stateDir);
    const inbox = await loadInbox(stateDir);
    output({ stateDir, inventoryGeneratedAt: inventory?.generatedAt ?? null, components: inventory?.components.length ?? 0, receipts: receipts.length, methods: methods.length, pendingImports: inbox.filter((entry) => entry.status === "pending").length }, options.json, (value) => `State: ${value.stateDir}\nComponents: ${value.components}\nReceipts: ${value.receipts}\nPending imports: ${value.pendingImports}\nPersonal Methods: ${value.methods}`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { process.stderr.write(`ownhow: ${error.message}\n`); process.exitCode = 1; });
