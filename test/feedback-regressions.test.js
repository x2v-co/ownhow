import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, scanRoots, scanRuntime } from "../src/scanner.js";
import { analyzeInventory, riskSignals, analysisComponents } from "../src/analyzer.js";
import { resolveTask } from "../src/resolver.js";
import { createReceipt, createProposal, saveProposal, applyProposal, rollbackMethod } from "../src/evolution.js";
import { loadMethods, loadReceipts } from "../src/store.js";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const skill = (id, extra = {}) => ({ id, kind: "skill", runtime: "codex", name: id, description: "review repository changes", source: `/fixture/${id}`, metadata: {}, triggers: [], tools: [], writes: [], sideEffects: [], lifecycle: { sessionVisible: true, enabled: true }, ...extra });
async function temporary(fn) { const dir = await mkdtemp(path.join(os.tmpdir(), "ownhow-regression-")); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test("parses actual YAML blocks, nested metadata and quoted lists; rejects invalid or tagged YAML", () => {
  const parsed = parseFrontmatter('---\nname: test\ndescription: >-\n  Review code\n  and resolve issues\nmetadata:\n  keywords: [review, "code, changes"]\ntriggers:\n  - "review: code"\n---\n');
  assert.equal(parsed.description, "Review code and resolve issues");
  assert.deepEqual(parsed.metadata.keywords, ["review", "code, changes"]);
  assert.deepEqual(parsed.triggers, ["review: code"]);
  assert.throws(() => parseFrontmatter('---\nname: one\nname: two\n---\n'), /Invalid Skill metadata/);
  assert.throws(() => parseFrontmatter('---\nname: !custom dangerous\n---\n'), /Invalid Skill metadata/);
  assert.throws(() => parseFrontmatter('---\nname: &a name\ndescription: *a\n---\n'));
});

test("metadata parse errors remain distinct from absent optional fields", async () => temporary(async (dir) => {
  await writeFile(path.join(dir, "SKILL.md"), '---\nname: first\nname: duplicate\n---\n');
  const inventory = await scanRoots({ roots: [dir], runtime: "codex", home: dir });
  const analysis = analyzeInventory(inventory);
  assert.equal(analysis.coverage.metadataErrors, 1);
  assert.equal(analysis.coverage.missingTriggers, 0);
  assert.equal(resolveTask(inventory, "duplicate").reason, "metadata_error");
}));

test("Skywork discovery finds actual source but does not claim it is active", async () => temporary(async (dir) => {
  const source = path.join(dir, ".skywork", "skills", "fixture");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), '---\nname: fixture\ndescription: test fixture\n---\n');
  const inventory = await scanRuntime({ runtime: "skywork", cwd: dir, home: dir });
  assert.equal(inventory.components.length, 1);
  assert.equal(inventory.components[0].runtime, "skywork");
  assert.equal(inventory.analysisScope, "runtime-roots");
  assert.equal(inventory.components[0].lifecycle.sessionVisible, null);
}));

test("mixed inventory retains per-runtime visibility and excludes explicitly disabled candidates", () => {
  const visible = skill("visible");
  const hidden = skill("hidden", { lifecycle: { sessionVisible: null } });
  const candidate = skill("candidate", { runtime: "skywork", lifecycle: { sessionVisible: null } });
  const disabled = skill("disabled", { runtime: "skywork", lifecycle: { enabled: false } });
  const inventory = { analysisScope: "runtime-roots", runtimeScopes: { codex: "session-visible", skywork: "runtime-roots" }, components: [visible, hidden, candidate, disabled] };
  assert.deepEqual(analysisComponents(inventory).map((item) => item.id), ["visible", "candidate"]);
});

test("cross-runtime copies are informational; conflicts inside one plugin are still checked", () => {
  const original = skill("a", { name: "shared", digest: "same", plugin: "bundle", writes: ["target"] });
  const copy = { ...original, id: "b", runtime: "pi" };
  const distribution = analyzeInventory({ components: [original, copy] });
  assert.equal(distribution.findings[0].type, "runtime_copy");
  assert.equal(distribution.findings[0].severity, "info");
  const collision = analyzeInventory({ components: [original, skill("c", { plugin: "bundle", writes: ["target"] })] });
  assert.equal(collision.findings[0].type, "write_collision");
  assert.equal(collision.findings[0].severity, "high");
});

test("read-only review does not demand external-message approval and alternatives do not pollute plans", () => {
  const readonly = skill("review", { description: "review code locally" });
  assert.deepEqual(riskSignals(readonly), []);
  const dangerous = skill("notify", { description: "review code locally", sideEffects: ["external_message"] });
  const plan = resolveTask({ components: [readonly, dangerous] }, "review");
  assert.equal(plan.primary.id, "review");
  assert.deepEqual(plan.augment, []);
  assert.deepEqual(plan.risks, []);
  assert.equal(plan.primary.requiresApproval, false);
  const send = resolveTask({ components: [dangerous] }, "notify");
  assert.equal(send.primary.requiresApproval, true);
});

test("actual distributed OwnHow skills select bilingual tasks and reject unrelated controls", async () => {
  const inventory = await scanRoots({ roots: [path.join(root, "skills"), path.join(root, "plugins", "ownhow")], runtime: "codex" });
  for (const component of inventory.components.filter((item) => item.kind === "skill")) {
    for (const query of ["检查我的本地 Skills 并分析能力重叠", "govern local AI skills and personal methods", "ownhow"]) assert.equal(resolveTask({ components: [component] }, query).primary?.id, component.id, `${component.name}: ${query}`);
    for (const query of ["修复 Codex 项目中的一个按钮", "create a calendar event", "send an email", "check payment billing"]) assert.equal(resolveTask({ components: [component] }, query).primary, null, query);
  }
});

test("excludes are honored; method selection uses best match and abstains on conflicting ties", () => {
  assert.equal(resolveTask({ components: [skill("review", { excludes: ["review repository"] })] }, "review repository").primary, null);
  const methods = [{ id: "broad", task: "review code", correction: "broad" }, { id: "exact", task: "review code locally", correction: "exact" }];
  assert.equal(resolveTask({ components: [] }, "review code locally", methods).methodId, "exact");
  assert.equal(resolveTask({ components: [] }, "review code locally", [...methods, { ...methods[1], id: "other", correction: "conflicting" }]).methodReason, "ambiguous");
});

test("method revisions preserve previous corrections and rollback creates a new revision", async () => temporary(async (state) => {
  const plan = resolveTask({ components: [] }, "review code locally");
  async function apply(correction) { const proposal = createProposal(createReceipt(plan.task, "failure", correction, plan)); await saveProposal(state, proposal); return applyProposal(state, proposal.id); }
  const first = await apply("run tests");
  const second = await apply("run focused tests");
  assert.equal(first.version, "0.1.0"); assert.equal(second.version, "0.1.1");
  const restored = await rollbackMethod(state, first.id, first.version);
  assert.equal(restored.version, "0.1.2"); assert.equal(restored.correction, first.correction);
  const third = await apply("verify delivery"); assert.equal(third.version, "0.1.3");
  assert.equal((await loadMethods(state))[0].version, third.version);
  const history = JSON.parse(await readFile(path.join(state, "method-history", "personal-review-code-locally", "0.1.1.json")));
  assert.equal(history.correction, second.correction);
}));

test("saved execution plan binds receipts, rejects tampering, and keeps unknown attribution honest", async () => temporary(async (dir) => {
  const cli = path.join(root, "src", "cli.js"); const planFile = path.join(dir, "plan.json"); const state = path.join(dir, "state");
  const args = ["--runtime", "codex", "--root", path.join(root, "skills"), "--state", state, "--json"];
  await exec(process.execPath, [cli, "resolve", "ownhow", ...args, "--save-plan", planFile]);
  const plan = JSON.parse(await readFile(planFile));
  await assert.rejects(exec(process.execPath, [cli, "record", "ownhow", ...args, "--plan", path.join(dir, "missing.json"), "--outcome", "success"]), /Saved plan not found/);
  await assert.rejects(exec(process.execPath, [cli, "record", "ownhow", ...args, "--runtime", "skywork", "--plan", planFile, "--outcome", "success"]), /runtime does not match/);
  await exec(process.execPath, [cli, "record", "ownhow", ...args, "--plan", planFile, "--outcome", "success", "--sample-kind", "workflow-test"]);
  const receipt = (await loadReceipts(state))[0];
  assert.equal(receipt.execution.planId, plan.id); assert.equal(receipt.execution.methodUse, "unknown");
  assert.equal(receipt.sampleKind, "workflow-test");
  plan.task = "tampered"; await writeFile(planFile, JSON.stringify(plan));
  await assert.rejects(exec(process.execPath, [cli, "record", "tampered", ...args, "--plan", planFile, "--outcome", "success"]), /digest/);
  const inbox = await exec(process.execPath, [cli, "inbox", "list", "--state", state, "--json"]); assert.deepEqual(JSON.parse(inbox.stdout), []);
}));

test("cached inventory must match the requested runtime and cannot hide a session manifest", async () => temporary(async (dir) => {
  const cli = path.join(root, "src", "cli.js");
  await exec(process.execPath, [cli, "scan", "--runtime", "codex", "--root", path.join(root, "skills"), "--state", dir]);
  const cached = ["--cached", "--state", dir, "--json"];
  const { stdout } = await exec(process.execPath, [cli, "resolve", "ownhow", "--runtime", "codex", ...cached]);
  assert.equal(JSON.parse(stdout).primary.name, "ownhow-governance");
  await assert.rejects(exec(process.execPath, [cli, "resolve", "ownhow", "--runtime", "skywork", ...cached]), /Cached inventory runtime/);
  await assert.rejects(exec(process.execPath, [cli, "resolve", "ownhow", "--runtime", "codex", ...cached, "--session-manifest", "ignored.json"]), /cannot be combined/);
}));

test("fast mode reuses a fresh matching snapshot and rejects explicit roots", async () => temporary(async (dir) => {
  const cli = path.join(root, "src", "cli.js");
  await exec(process.execPath, [cli, "scan", "--runtime", "codex", "--root", path.join(root, "skills"), "--state", dir]);
  const { stdout } = await exec(process.execPath, [cli, "resolve", "ownhow", "--runtime", "codex", "--fast", "--state", dir, "--json"]);
  assert.equal(JSON.parse(stdout).inventoryMode, "fast");
  await assert.rejects(exec(process.execPath, [cli, "resolve", "ownhow", "--runtime", "codex", "--fast", "--root", path.join(root, "skills"), "--state", dir]), /cannot be combined/);
}));

test("host manifest restricts scope; doctor reports paths without creating state", async () => temporary(async (dir) => {
  const file = path.join(dir, "manifest.json"); const state = path.join(dir, "state");
  await writeFile(file, JSON.stringify({ runtime: "skywork", skillFiles: [path.join(root, "skills", "ownhow-governance", "SKILL.md")] }));
  const { stdout } = await exec(process.execPath, [path.join(root, "src", "cli.js"), "doctor", "--runtime", "skywork", "--session-manifest", file, "--state", state, "--json"]);
  const doctor = JSON.parse(stdout); assert.equal(doctor.scope, "session-visible"); assert.equal(doctor.authoritative, true); assert.equal(doctor.ownhowComponents.length, 1); assert.equal(doctor.lifecycle.sessionVisible, 1); assert.equal(doctor.lifecycle.unknownSessionVisibility, 0);
  await assert.rejects(readFile(path.join(state, "inventory.json")));
}));

test("standalone and plugin workflows remain identical except for their entrypoint name", async () => {
  const standalone = await readFile(path.join(root, "skills", "ownhow-governance", "SKILL.md"), "utf8");
  const plugin = await readFile(path.join(root, "plugins", "ownhow", "skills", "govern-personal-methods", "SKILL.md"), "utf8");
  assert.equal(standalone, plugin.replace("name: govern-personal-methods", "name: ownhow-governance"));
});
