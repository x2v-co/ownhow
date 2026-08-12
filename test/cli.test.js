import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { access, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = path.join(root, "test", "fixtures", "home");

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
    /--runtime must be codex, hermes, or all/
  );
});
