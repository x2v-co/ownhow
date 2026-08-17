import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { access, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { appendReceipt, loadReceipts } from "../src/store.js";
import { parseReceiptCapsule } from "../src/receipt-bundle.js";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = path.join(root, "test", "fixtures", "home");

function execWithInput(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `Process exited with ${code}`)));
    child.stdin.end(input);
  });
}

test("supports conventional top-level help", async () => {
  const { stdout } = await exec(process.execPath, [path.join(root, "src", "cli.js"), "--help"]);
  assert.match(stdout, /OwnHow MVP/);
  assert.match(stdout, /ownhow scan/);
});

test("analyzes live roots without creating local state", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-cli-test-"));
  const state = path.join(temporary, "state-must-not-exist");
  try {
    const { stdout } = await exec(process.execPath, [path.join(root, "src", "cli.js"), "analyze", "--root", path.join(fixtures, ".codex", "plugins"), "--root", path.join(fixtures, ".agents", "skills"), "--state", state, "--json"]);
    const analysis = JSON.parse(stdout);
    assert.equal(analysis.coverage.totalSkills, 2);
    assert.equal(analysis.inventoryMode, "live");
    await assert.rejects(access(state));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("resolves against a Hermes-only inventory", async () => {
  const { stdout } = await exec(process.execPath, [
    path.join(root, "src", "cli.js"),
    "resolve",
    "research a topic and cite findings",
    "--runtime",
    "hermes",
    "--root",
    path.join(fixtures, ".hermes", "skills"),
    "--json"
  ]);
  const plan = JSON.parse(stdout);
  assert.equal(plan.primary.name, "hermes-research");
  assert.equal(plan.primary.runtime, "hermes");
});

test("rejects unknown runtimes", async () => {
  await assert.rejects(
    exec(process.execPath, [path.join(root, "src", "cli.js"), "analyze", "--runtime", "other"]),
    /--runtime must be codex, hermes, claude, pi, opencode, openclaw, or all/
  );
});

test("accepts a Claude-only inventory", async () => {
  const { stdout } = await exec(process.execPath, [
    path.join(root, "src", "cli.js"),
    "analyze",
    "--runtime",
    "claude",
    "--root",
    path.join(fixtures, ".agents", "skills"),
    "--json"
  ]);
  const analysis = JSON.parse(stdout);
  assert.equal(analysis.coverage.totalSkills, 1);
});

for (const runtime of ["pi", "opencode", "openclaw"]) {
  test(`accepts a ${runtime}-only inventory`, async () => {
    const { stdout } = await exec(process.execPath, [
      path.join(root, "src", "cli.js"), "analyze", "--runtime", runtime,
      "--root", path.join(fixtures, ".agents", "skills"), "--json"
    ]);
    const analysis = JSON.parse(stdout);
    assert.equal(analysis.coverage.totalSkills, 1);
  });
}

test("round-trips a remote receipt through the pending inbox before proposal", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-cli-bundle-test-"));
  const state = path.join(temporary, "state");
  const cli = path.join(root, "src", "cli.js");
  try {
    await appendReceipt(state, {
      id: "receipt-source",
      createdAt: "2026-08-13T02:00:00.000Z",
      task: "Research customer onboarding",
      outcome: "failure",
      correction: "Cite the customer's exact observed workflow",
      runtime: "hermes",
      plan: { methodId: null, primary: null, augment: [], risks: [] }
    });
    const exported = await exec(process.execPath, [cli, "export", "--receipt", "latest", "--agent-id", "research-agent", "--state", state]);
    assert.equal(exported.stdout.trim().split("\n").length, 1);
    assert.match(exported.stdout, /^ownhow:receipt-bundle:v2:/);

    await rm(state, { recursive: true, force: true });
    const imported = await execWithInput(process.execPath, [cli, "import", "-", "--state", state, "--json"], exported.stdout);
    const pending = JSON.parse(imported.stdout);
    assert.equal(pending.status, "pending");
    assert.equal(pending.source.agentId, "research-agent");
    assert.deepEqual(await loadReceipts(state), []);

    await assert.rejects(exec(process.execPath, [cli, "propose", "--receipt", "receipt-source", "--state", state]), /No matching receipt/);
    const accepted = await exec(process.execPath, [cli, "inbox", "accept", pending.id, "--state", state, "--json"]);
    const acceptedReceiptId = JSON.parse(accepted.stdout).receiptId;
    const proposed = await exec(process.execPath, [cli, "propose", "--receipt", acceptedReceiptId, "--state", state, "--json"]);
    assert.equal(JSON.parse(proposed.stdout).correction, "Cite the customer's exact observed workflow");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("records evidence and keeps latest export scoped to local receipts", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-cli-evidence-test-"));
  const state = path.join(temporary, "state");
  const cli = path.join(root, "src", "cli.js");
  try {
    const recorded = await exec(process.execPath, [
      cli, "record", "verify login fix", "--outcome", "success", "--runtime", "codex",
      "--summary", "Login flow verified", "--evidence", "npm test: 42 passed", "--artifact", "src/auth.js",
      "--confidence", "high", "--verified-by", "user", "--state", state, "--json"
    ]);
    const receipt = JSON.parse(recorded.stdout);
    assert.equal(receipt.details.summary, "Login flow verified");
    assert.deepEqual(receipt.details.evidence, ["npm test: 42 passed"]);

    const remote = await exec(process.execPath, [
      cli, "export", "--receipt", receipt.id, "--agent-id", "remote-a", "--runtime", "codex", "--protocol", "v2", "--state", state
    ]);
    await execWithInput(process.execPath, [cli, "import", "-", "--state", state, "--json"], remote.stdout);
    const inbox = JSON.parse((await exec(process.execPath, [cli, "inbox", "--state", state, "--json"])).stdout);
    const shown = JSON.parse((await exec(process.execPath, [cli, "inbox", "show", inbox[0].id, "--state", state, "--json"])).stdout);
    assert.equal(shown.sourceAuthenticated, false);
    assert.equal(shown.details.summary, "Login flow verified");
    assert.deepEqual(shown.details.evidence, ["npm test: 42 passed"]);
    const accepted = await exec(process.execPath, [cli, "inbox", "accept", inbox[0].id, "--state", state, "--json"]);
    const importedId = JSON.parse(accepted.stdout).receiptId;
    const acceptedReceipt = (await loadReceipts(state)).find((item) => item.id === importedId);
    assert.equal(acceptedReceipt.details.summary, "Login flow verified");
    assert.deepEqual(acceptedReceipt.details.evidence, ["npm test: 42 passed"]);
    await assert.rejects(exec(process.execPath, [cli, "export", "--receipt", importedId, "--agent-id", "local-a", "--state", state]), /Refusing to re-export/);
    await assert.rejects(exec(process.execPath, [cli, "export", "--receipt", importedId, "--agent-id", "local-a", "--reexport-imported", "--state", state]), /Use --source imported/);
    const reexported = await exec(process.execPath, [cli, "export", "--receipt", importedId, "--agent-id", "relay-a", "--source", "imported", "--reexport-imported", "--state", state]);
    assert.match(reexported.stdout, /^ownhow:receipt-bundle:v2:/);
    const localExport = await exec(process.execPath, [cli, "export", "--agent-id", "local-a", "--state", state]);
    assert.match(localExport.stdout, /^ownhow:receipt-bundle:v2:/);

    await appendReceipt(state, {
      id: "receipt-hermes-newer", createdAt: "2026-08-17T03:00:00.000Z", task: "newer Hermes task",
      outcome: "success", correction: null, runtime: "hermes", plan: { methodId: null, primary: null, augment: [], risks: [] }
    });
    const codexExport = await exec(process.execPath, [cli, "export", "--agent-id", "local-a", "--runtime", "codex", "--state", state]);
    const codexBundle = parseReceiptCapsule(codexExport.stdout);
    assert.equal(codexBundle.source.runtime, "codex");
    assert.equal(codexBundle.receipt.task, "verify login fix");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
