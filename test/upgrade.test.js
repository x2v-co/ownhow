import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { upgrade, validateBundle, compareVersions, updateNotice, PACKAGE_ROOT } from "../src/upgrade.js";
const exec = promisify(execFile);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ownhow-upgrade-"));
  try {
    const install = path.join(dir, "node_modules/ownhow"), state = path.join(dir, "state"), skill = path.join(dir, "skills/ownhow-governance");
    await mkdir(install, { recursive: true }); await mkdir(skill, { recursive: true });
    await writeFile(path.join(install, "package.json"), JSON.stringify({ name: "ownhow", version: "0.6.0" }));
    await writeFile(path.join(install, "old.txt"), "old installation");
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: ownhow-governance\nversion: 0.6.0\n---\nold skill");
    const version = "0.6.1";
    const bundle = { schemaVersion: 1, version, files: [
      { path: "package.json", content: JSON.stringify({ name: "ownhow", version, type: "module" }) },
      { path: "src/cli.js", content: "// synthetic fixture" },
      { path: "skills/ownhow-governance/SKILL.md", content: `---\nname: ownhow-governance\nversion: ${version}\n---\nnew skill` }
    ] };
    const bytes = Buffer.from(JSON.stringify(bundle));
    const manifest = { schemaVersion: 1, channel: "stable", version, sha256: createHash("sha256").update(bytes).digest("hex") };
    const calls = [];
    const deps = { currentRoot: install, smoke: async () => {}, download: async (url) => { calls.push(url); return url.endsWith("ownhow-update.json") ? Buffer.from(JSON.stringify(manifest)) : bytes; } };
    await fn({ dir, install, state, skill, bundle, bytes, manifest, deps, calls });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test("stable versions and push notices reject command-like or prerelease input", () => {
  assert.equal(compareVersions("0.6.10", "0.6.9"), 1);
  assert.equal(updateNotice("0.6.1"), "ownhow:update:v1:0.6.1");
  for (const value of ["0.7.0-rc.1", "../main", "1.2.3;echo bad", "01.2.3"]) assert.throws(() => updateNotice(value));
});
test("check is read-only; verified update switches CLI and Skill together and preserves state", () => fixture(async ({ install, state, skill, deps }) => {
  const check = await upgrade({ check: true, "skill-dir": skill }, state, deps);
  assert.equal(check.status, "update_available");
  await assert.rejects(readdir(state), /ENOENT/);
  await mkdir(state); await writeFile(path.join(state, "receipts.jsonl"), "private evidence");
  const result = await upgrade({ apply: true, "skill-dir": skill }, state, deps);
  assert.equal(result.status, "updated"); assert.equal(result.sessionReloadRequired, true);
  assert.equal((await json(path.join(install, "package.json"))).version, "0.6.1");
  assert.match(await readFile(path.join(skill, "SKILL.md"), "utf8"), /version: 0.6.1/);
  assert.equal(await readFile(path.join(state, "receipts.jsonl"), "utf8"), "private evidence");
  assert.equal(result.backups.length, 2);
  assert.equal((await upgrade({ apply: true, "skill-dir": skill }, state, deps)).status, "up_to_date");
}));
test("checksum mismatch and unsafe bundle paths never activate code", () => fixture(async ({ state, deps, manifest, bundle, install }) => {
  manifest.sha256 = "0".repeat(64);
  await assert.rejects(upgrade({ apply: true }, state, deps), /checksum/);
  assert.equal(await readFile(path.join(install, "old.txt"), "utf8"), "old installation");
  for (const target of ["../escape", "src/../../escape", "/absolute", "src/evil\\file", "src//double"]) assert.throws(() => validateBundle({ ...bundle, files: [...bundle.files, { path: target, content: "bad" }] }, bundle.version), /path/);
}));
test("failed post-activation verification restores both destinations", () => fixture(async ({ state, skill, deps, install }) => {
  let checks = 0;
  deps.smoke = async () => { if (++checks === 2) throw new Error("business smoke failed"); };
  await assert.rejects(upgrade({ apply: true, "skill-dir": skill }, state, deps), /business smoke failed/);
  assert.equal((await json(path.join(install, "package.json"))).version, "0.6.0");
  assert.match(await readFile(path.join(skill, "SKILL.md"), "utf8"), /old skill/);
  await assert.rejects(readFile(path.join(state, "updates/transaction.json")), /ENOENT/);
}));
test("automatic updates require enrollment, throttle checks, and restrict minor updates", () => fixture(async ({ state, skill, deps, calls, manifest }) => {
  assert.equal((await upgrade({ auto: true }, state, deps)).status, "auto_disabled");
  assert.equal(calls.length, 0);
  await upgrade({ "enable-auto": true, "skill-dir": skill }, state, deps);
  assert.equal((await upgrade({ auto: true }, state, deps)).status, "updated");
  assert.equal((await upgrade({ auto: true }, state, deps)).status, "check_throttled");
  manifest.version = "0.7.0";
  assert.equal((await upgrade({ auto: true, notice: "ownhow:update:v1:0.7.0" }, state, deps)).status, "approval_required");
  await upgrade({ "disable-auto": true }, state, deps);
  assert.equal((await upgrade({ auto: true }, state, deps)).status, "auto_disabled");
}));
test("push notices fetch a fixed official version and mismatches are rejected", () => fixture(async ({ state, deps, calls }) => {
  await assert.rejects(upgrade({ check: true, notice: "ownhow:update:v1:0.6.2" }, state, deps), /manifest/);
  assert.equal(calls[0], "https://github.com/x2v-co/ownhow/releases/download/v0.6.2/ownhow-update.json");
  await assert.rejects(upgrade({ check: true, notice: "https://attacker.invalid/script" }, state, deps), /notice/);
}));
test("source checkouts, plugin caches, and conflicting modes are not mutated", () => fixture(async ({ install, state, deps, dir }) => {
  await mkdir(path.join(install, ".git"));
  await assert.rejects(upgrade({ apply: true }, state, deps), /checkout/);
  await assert.rejects(upgrade({ check: true, "skill-dir": path.join(dir, ".codex/plugins/cache/ownhow") }, state, deps), /host-managed/);
  await assert.rejects(upgrade({ check: true, apply: true }, state, deps), /one upgrade mode/);
}));
test("release builder creates a real runnable same-version bundle", () => fixture(async ({ dir, state }) => {
  const output = path.join(dir, "release");
  await exec(process.execPath, [path.join(PACKAGE_ROOT, "scripts/build-release.js"), output]);
  const pkg = await json(path.join(PACKAGE_ROOT, "package.json"));
  const fresh = path.join(dir, "fresh-install");
  const result = await upgrade({ apply: true, "install-dir": fresh }, state, { currentRoot: PACKAGE_ROOT, download: async (url) => readFile(path.join(output, url.endsWith("ownhow-update.json") ? "ownhow-update.json" : "ownhow-bundle.json")) });
  assert.equal(result.cliVersion, pkg.version);
  assert.equal(result.verification, "passed");
}));
test("interrupted activation recovers before downloads and concurrent updater is refused", () => fixture(async ({ install, state, skill, deps, calls }) => {
  const { rename } = await import("node:fs/promises");
  const backup = install + ".backup", staged = install + ".staged";
  await rename(install, backup); await mkdir(install);
  await writeFile(path.join(install, "package.json"), JSON.stringify({ name: "ownhow", version: "0.6.1" }));
  await mkdir(path.join(state, "updates"), { recursive: true });
  await writeFile(path.join(state, "updates/transaction.json"), JSON.stringify({ targets: [{ target: install, backup, staged, existed: true }] }));
  assert.equal((await upgrade({ recover: true }, state, deps)).status, "recovered");
  assert.equal(await readFile(path.join(install, "old.txt"), "utf8"), "old installation");
  assert.equal(calls.length, 0);
  await mkdir(path.join(state, "updates/lock"));
  await assert.rejects(upgrade({ apply: true }, state, deps), /Another updater/);
}));
test("destinations cannot contain OwnHow state", () => fixture(async ({ state, deps, install }) => {
  await assert.rejects(upgrade({ apply: true, "skill-dir": state }, state, deps), /outside OwnHow state/);
  await assert.rejects(upgrade({ apply: true }, path.join(install, "private-state"), deps), /outside the install/);
}));
