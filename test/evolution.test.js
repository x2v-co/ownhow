import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { scanRoots } from "../src/scanner.js";
import { resolveTask } from "../src/resolver.js";
import { applyProposal, createProposal, createReceipt, saveProposal } from "../src/evolution.js";
import { ensureState, loadMethods } from "../src/store.js";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "home");

test("applies an explicit Personal Method overlay and reuses its correction", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "ownhow-test-"));
  try {
    await ensureState(stateDir);
    const inventory = await scanRoots({ roots: [path.join(fixtures, ".codex", "plugins"), path.join(fixtures, ".agents", "skills")] });
    const task = "review merge request and fix findings";
    const firstPlan = resolveTask(inventory, task, []);
    assert.equal(firstPlan.primary.name, "reviewer");
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
