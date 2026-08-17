#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { analyzeInventory } from "./analyzer.js";
import { applyProposal, createProposal, createReceipt, saveProposal } from "./evolution.js";
import { formatAnalysis, formatInventory, formatPlan } from "./format.js";
import { acceptInboxEntry, createReceiptCapsule, importReceiptCapsule, rejectInboxEntry } from "./receipt-bundle.js";
import { resolveTask } from "./resolver.js";
import { runtimeRoots, scanRoots, scanRuntime } from "./scanner.js";
import { appendReceipt, loadInbox, loadInboxEntry, loadInventory, loadMethods, loadReceipts, saveInventory, stateDirectory } from "./store.js";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  const listKeys = new Set(["evidence", "artifact", "blocker"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const key = value.slice(2);
    if (["json", "help", "cached", "reexport-imported"].includes(key)) { options[key] = true; continue; }
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
  ownhow scan [--runtime codex|hermes|claude|pi|opencode|openclaw|all] [--root PATH] [--state PATH] [--json]
  ownhow analyze [--runtime codex|hermes|claude|pi|opencode|openclaw|all] [--root PATH] [--cached] [--state PATH] [--json]
  ownhow resolve <task> [--runtime codex|hermes|claude|pi|opencode|openclaw|all] [--root PATH] [--cached] [--state PATH] [--json]
  ownhow record <task> --outcome success|failure [--correction TEXT] [--summary TEXT] [--evidence TEXT] [--artifact PATH] [--blocker TEXT] [--confidence low|medium|high] [--verified-by user|agent|automated|unknown] [--runtime codex|hermes|claude|pi|opencode|openclaw|all] [--root PATH] [--cached] [--state PATH] [--json]
  ownhow export --receipt latest|ID --agent-id ID [--source local|imported|all] [--reexport-imported] [--protocol v1|v2] [--runtime codex|hermes|claude|pi|opencode|openclaw|all] [--state PATH] [--json]
  ownhow import <capsule|-> [--state PATH] [--json]
  ownhow inbox [show|accept|reject] [import-id] [--state PATH] [--json]
  ownhow propose [--receipt latest|ID] [--state PATH] [--json]
  ownhow apply <proposal-id> [--state PATH] [--json]
  ownhow status [--state PATH] [--json]

Analyze and resolve use the live installation by default and do not write state.
OwnHow never edits installed Plugins or Skills.`;
}

function output(value, json, formatter = null) { process.stdout.write(`${json || !formatter ? JSON.stringify(value, null, 2) : formatter(value)}\n`); }
function requireTask(parts) { const task = parts.join(" ").trim(); if (!task) throw new Error("Task is required."); return task; }
function runtimeFor(options) {
  const runtime = options.runtime ?? "all";
  if (!["codex", "hermes", "claude", "pi", "opencode", "openclaw", "all"].includes(runtime)) throw new Error("--runtime must be codex, hermes, claude, pi, opencode, openclaw, or all.");
  return runtime;
}
async function rootsFor(options) { return options.root?.map((root) => path.resolve(root)) ?? runtimeRoots({ runtime: runtimeFor(options) }); }
function sourceRuntimeFor(options) { return options.root && runtimeFor(options) !== "all" ? runtimeFor(options) : "auto"; }
async function liveInventory(options) { return options.root ? scanRoots({ roots: await rootsFor(options), runtime: sourceRuntimeFor(options) }) : scanRuntime({ runtime: runtimeFor(options) }); }
async function inventoryFor(options, stateDir) { return options.cached ? loadInventory(stateDir) : liveInventory(options); }
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

  if (command === "scan") {
    const inventory = await liveInventory(options);
    await saveInventory(stateDir, inventory);
    output(inventory, options.json, formatInventory);
    return;
  }
  if (command === "analyze") {
    const inventory = await inventoryFor(options, stateDir);
    const analysis = { ...analyzeInventory(inventory), inventoryMode: options.cached ? "cached" : "live", inventoryGeneratedAt: inventory.generatedAt, inventoryAnalysisScope: inventory.analysisScope ?? "unknown" };
    output(analysis, options.json, formatAnalysis);
    return;
  }
  if (command === "resolve" || command === "record") {
    const task = requireTask(positional);
    const inventory = await inventoryFor(options, stateDir);
    const plan = { ...resolveTask(inventory, task, await loadMethods(stateDir)), inventoryMode: options.cached ? "cached" : "live", inventoryGeneratedAt: inventory.generatedAt, inventoryAnalysisScope: inventory.analysisScope ?? "unknown" };
    if (command === "resolve") { output(plan, options.json, formatPlan); return; }
    if (!['success', 'failure'].includes(options.outcome)) throw new Error("--outcome must be success or failure.");
    const confidence = options.confidence ?? "unknown";
    const verifiedBy = options["verified-by"] ?? "unknown";
    if (!["low", "medium", "high", "unknown"].includes(confidence)) throw new Error("--confidence must be low, medium, high, or unknown.");
    if (!["user", "agent", "automated", "unknown"].includes(verifiedBy)) throw new Error("--verified-by must be user, agent, automated, or unknown.");
    const receipt = createReceipt(task, options.outcome, options.correction, plan, {
      runtime: runtimeFor(options),
      summary: options.summary,
      evidence: options.evidence,
      artifacts: options.artifact,
      blockers: options.blocker,
      confidence,
      verifiedBy
    });
    await appendReceipt(stateDir, receipt);
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
    if (!action) {
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
