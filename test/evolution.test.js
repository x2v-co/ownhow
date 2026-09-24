import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { scanRoots } from "../src/scanner.js";
import { resolveTask } from "../src/resolver.js";
import { applyProposal, createProposal, createReceipt, normalizeGovernance, saveProposal } from "../src/evolution.js";
import { ensureState, loadMethods } from "../src/store.js";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "home");

test("records typed governance lifecycle evidence without inventing unknown states", () => {
  const plan = { id: "plan-1", digest: "digest", methodId: "personal:review", methodVersion: "0.1.0", primary: null, augment: [], risks: [] };
  const followed = createReceipt("review", "success", null, plan, { methodUse: "followed", verifiedBy: "user", executionPlan: true });
  assert.deepEqual(followed.governance, { discovered: true, matched: true, loaded: true, actualUsed: true, followed: true, reused: true, verified: true });
  const unknown = createReceipt("review", "failure", null, { ...plan, methodId: null }, { methodUse: "unknown" });
  assert.equal(unknown.governance.discovered, true);
  assert.equal(unknown.governance.matched, false);
  assert.equal(unknown.governance.loaded, false);
  assert.equal(unknown.governance.verified, null);
  const unreported = createReceipt("review", "success", null, plan, { methodUse: "unknown" });
  assert.equal(unreported.governance.actualUsed, null);
  assert.deepEqual(normalizeGovernance({ loaded: null }), { discovered: null, matched: null, loaded: null, actualUsed: null, followed: null, reused: null, verified: null });
  assert.equal(normalizeGovernance({ used: true }).actualUsed, true);
  assert.throws(() => normalizeGovernance({ loaded: "yes" }), /boolean or null/);
});

test("applies an explicit Personal Method overlay and reuses its correction", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "ownhow-test-"));
  try {
    await ensureState(stateDir);
    const inventory = await scanRoots({ roots: [path.join(fixtures, ".codex", "plugins"), path.join(fixtures, ".agents", "skills")] });
    const task = "review merge request and fix findings";
    const firstPlan = resolveTask(inventory, task, []);
    assert.equal(firstPlan.primary.name, "reviewer");
    assert.equal(firstPlan.methodId, null);
    const receipt = createReceipt(task, "failure", "Do not send a message until tests pass.", firstPlan);
    const proposal = createProposal(receipt);
    await saveProposal(stateDir, proposal);
    const method = await applyProposal(stateDir, proposal.id);
    assert.equal(method.correction, "Do not send a message until tests pass.");
    const secondPlan = resolveTask(inventory, task, await loadMethods(stateDir));
    assert.equal(secondPlan.correction, method.correction);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
