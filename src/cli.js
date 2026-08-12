#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { analyzeInventory } from "./analyzer.js";
import { applyProposal, createProposal, createReceipt, saveProposal } from "./evolution.js";
import { formatAnalysis, formatInventory, formatPlan } from "./format.js";
import { resolveTask } from "./resolver.js";
import { runtimeRoots, scanRoots, scanRuntime } from "./scanner.js";
import { appendReceipt, loadInventory, loadMethods, loadReceipts, saveInventory, stateDirectory } from "./store.js";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const key = value.slice(2);
    if (["json", "help", "cached"].includes(key)) { options[key] = true; continue; }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    index += 1;
    if (key === "root") options.root = [...(options.root ?? []), next];
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
  ownhow record <task> --outcome success|failure [--correction TEXT] [--runtime codex|hermes|claude|pi|opencode|openclaw|all] [--root PATH] [--cached] [--state PATH] [--json]
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
    const analysis = { ...analyzeInventory(inventory), inventoryMode: options.cached ? "cached" : "live", inventoryGeneratedAt: inventory.generatedAt };
    output(analysis, options.json, formatAnalysis);
    return;
  }
  if (command === "resolve" || command === "record") {
    const task = requireTask(positional);
    const inventory = await inventoryFor(options, stateDir);
    const plan = { ...resolveTask(inventory, task, await loadMethods(stateDir)), inventoryMode: options.cached ? "cached" : "live", inventoryGeneratedAt: inventory.generatedAt };
    if (command === "resolve") { output(plan, options.json, formatPlan); return; }
    if (!['success', 'failure'].includes(options.outcome)) throw new Error("--outcome must be success or failure.");
    const receipt = createReceipt(task, options.outcome, options.correction, plan);
    await appendReceipt(stateDir, receipt);
    output(receipt, options.json, (value) => `Recorded ${value.id}\nOutcome: ${value.outcome}\nCorrection: ${value.correction ?? "none"}`);
    return;
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
    output({ stateDir, inventoryGeneratedAt: inventory?.generatedAt ?? null, components: inventory?.components.length ?? 0, receipts: receipts.length, methods: methods.length }, options.json, (value) => `State: ${value.stateDir}\nComponents: ${value.components}\nReceipts: ${value.receipts}\nPersonal Methods: ${value.methods}`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { process.stderr.write(`ownhow: ${error.message}\n`); process.exitCode = 1; });
