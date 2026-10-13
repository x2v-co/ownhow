import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditSkill, REQUIRED_CHECKS } from "../src/audit-checks.js";
import { scanRoots } from "../src/scanner.js";
import { analyzeInventory } from "../src/analyzer.js";
import { formatAnalysis } from "../src/format.js";

const exec = promisify(execFile);
async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ownhow-audit-"));
  try {
    await writeFile(path.join(root, "SKILL.md"), "---\nname: audit-fixture\ndescription: synthetic fixture\n---\n");
    await writeFile(path.join(root, "module.py"), "value = 'reviewed'\n");
    await utimes(path.join(root, "module.py"), 1700000000, 1700000000);
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function timestampCache(root, relative = "module.pyc", { mtime, size, magic = 3571, flags = 0, body = true } = {}) {
  const source = await stat(path.join(root, "module.py"));
  const headerSize = magic === 62211 ? 8 : magic === 3379 ? 12 : 16;
  const buffer = Buffer.alloc(headerSize + (body ? 1 : 0));
  buffer.writeUInt16LE(magic, 0);
  buffer[2] = 13; buffer[3] = 10;
  if (headerSize === 16) buffer.writeUInt32LE(flags, 4);
  const offset = headerSize === 16 ? 8 : 4;
  buffer.writeUInt32LE(mtime ?? (Math.floor(source.mtimeMs / 1000) >>> 0), offset);
  if (headerSize >= 12) buffer.writeUInt32LE(size ?? source.size, offset + 4);
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  return file;
}
const bytecode = async (root, options) => (await auditSkill({ source: root }, options)).python_bytecode;
async function requirePython(t) {
  try { await exec("python3", ["-I", "-S", "-c", "import py_compile"]); return true; }
  catch { t.skip("python3 is required to generate real bytecode fixtures"); return false; }
}

test("mandatory bytecode check accepts matching modern and legacy timestamp headers", async () => fixture(async (root) => {
  await timestampCache(root);
  await timestampCache(root, "__pycache__/module.cpython-313.opt-2.pyc");
  await timestampCache(root, "legacy/module.pyc", { magic: 3379 });
  await writeFile(path.join(root, "legacy/module.py"), await readFile(path.join(root, "module.py")));
  await utimes(path.join(root, "legacy/module.py"), 1700000000, 1700000000);
  await timestampCache(root, "python2/module.pyc", { magic: 62211 });
  await writeFile(path.join(root, "python2/module.py"), await readFile(path.join(root, "module.py")));
  await utimes(path.join(root, "python2/module.py"), 1700000000, 1700000000);
  await utimes(path.join(root, "module.py"), 1700000000.75, 1700000000.75);
  const checked = await bytecode(root);
  assert.equal(checked.status, "pass");
  assert.equal(checked.inspected, 4);
  assert.ok(REQUIRED_CHECKS.some((check) => check.id === checked.id && check.required));
}));

test("detects stale mtime, stale size, orphan caches and source-less legacy bytecode", async () => fixture(async (root) => {
  await timestampCache(root, "__pycache__/module.cpython-313.pyc", { mtime: 1700000001 });
  await timestampCache(root, "module.pyc", { size: 100 });
  await timestampCache(root, "build/__pycache__/missing.cpython-313.pyc");
  await timestampCache(root, "build/__pycache__/unusual.pyc");
  await timestampCache(root, "tmp/orphan.pyc");
  const checked = await bytecode(root);
  assert.equal(checked.status, "findings");
  assert.equal(checked.findings.filter((finding) => finding.reason === "timestamp_size_mismatch").length, 2);
  assert.equal(checked.findings.filter((finding) => finding.reason === "missing_source").length, 3);
  assert.ok(checked.findings.every((finding) => finding.severity === "high" && finding.sourcePath.endsWith(".py")));
}));

test("malformed bytecode fails and unsupported formats remain unknown", async () => fixture(async (root) => {
  await timestampCache(root, "module.pyc", { flags: 2 });
  assert.equal((await bytecode(root)).findings[0].reason, "invalid_flags");
  await timestampCache(root, "module.pyc", { body: false });
  assert.equal((await bytecode(root)).findings[0].reason, "invalid_header");
  await writeFile(path.join(root, "module.pyc"), Buffer.from([1, 2, 3]));
  assert.equal((await bytecode(root)).findings[0].reason, "invalid_header");
  await timestampCache(root, "module.pyc", { magic: 9999 });
  assert.equal((await bytecode(root)).status, "unknown");
  assert.equal((await bytecode(root)).limitations[0].reason, "unsupported_magic");
}));

test("real py_compile fixtures verify checked and unchecked PEP 552 hashes without executing source", async (t) => {
  if (!await requirePython(t)) return;
  await fixture(async (root) => {
    await writeFile(path.join(root, "module.py"), "open('executed', 'w').write('bad')\nvalue = '你好'\r\n");
    for (const mode of ["CHECKED_HASH", "UNCHECKED_HASH"]) {
      await exec("python3", ["-I", "-S", "-c", `import py_compile; py_compile.compile('module.py', cfile='module.pyc', invalidation_mode=py_compile.PycInvalidationMode.${mode})`], { cwd: root });
      const original = await readFile(path.join(root, "module.py"));
      assert.equal((await bytecode(root)).status, "pass");
      await writeFile(path.join(root, "module.py"), original.toString().replace("bad", "new"));
      const checked = await bytecode(root);
      assert.equal(checked.findings[0].reason, "hash_mismatch");
      assert.equal(checked.findings[0].checkedHash, mode === "CHECKED_HASH");
      await writeFile(path.join(root, "module.py"), original);
    }
    await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  });
});

test("real python3 -m py_compile cache is found and detects a subsequent source change", async (t) => {
  if (!await requirePython(t)) return;
  await fixture(async (root) => {
    await exec("python3", ["-I", "-S", "-m", "py_compile", "module.py"], { cwd: root });
    assert.equal((await bytecode(root)).status, "pass");
    await writeFile(path.join(root, "module.py"), "value = 'changed source'\n");
    assert.equal((await bytecode(root)).findings[0].reason, "timestamp_size_mismatch");
  });
});

test("unavailable hash verification, missing roots and symlinks cannot produce a pass", async () => fixture(async (root) => {
  await timestampCache(root, "module.pyc", { flags: 1 });
  const checked = await bytecode(root, { hashSource: async () => ({ reason: "hash_verifier_unavailable" }) });
  assert.equal(checked.status, "unknown");
  assert.equal(checked.limitations[0].reason, "hash_verifier_unavailable");
  assert.equal((await bytecode(path.join(root, "missing"))).status, "unknown");
  assert.equal((await auditSkill({ source: "openclaw:runtime" })).python_bytecode.status, "unknown");
  await symlink(path.join(root, "module.pyc"), path.join(root, "linked.pyc"));
  assert.ok((await bytecode(root)).limitations.some((item) => item.reason === "uninspected_special_file"));
}));

test("scanner and analyzer expose required bytecode findings even in discovery-pruned caches", async () => fixture(async (root) => {
  await timestampCache(root, "__pycache__/missing.cpython-313.pyc");
  const inventory = await scanRoots({ roots: [root], runtime: "hermes", home: root, cwd: root });
  assert.equal(inventory.components.length, 1);
  assert.equal(inventory.components[0].auditChecks.python_bytecode.status, "findings");
  const analysis = analyzeInventory(inventory);
  const finding = analysis.findings.find((item) => item.type === "python_bytecode");
  assert.equal(finding.reason, "missing_source");
  assert.deepEqual(finding.components, [inventory.components[0].id]);
  assert.equal(analysis.requiredChecks.find((check) => check.id === "python_bytecode").findingSkills, 1);
  assert.match(formatAnalysis(analysis), /Required check: python_bytecode=findings/);
  assert.match(formatAnalysis(analysis), /missing_source/);
}));

test("old cached inventories and invisible Skills preserve mandatory-check uncertainty", () => {
  const component = { id: "old", kind: "skill", name: "old", description: "cached" };
  const analysis = analyzeInventory({ components: [component] });
  assert.equal(analysis.requiredChecks[0].status, "unknown");
  assert.equal(analysis.requiredChecks[0].unknownSkills, 1);
  component.lifecycle = { enabled: false };
  component.auditChecks = { python_bytecode: { status: "findings", findings: [{ severity: "high" }], limitations: [] } };
  assert.equal(analyzeInventory({ components: [component] }).findings.length, 0);
});

async function residueFixture(fn) {
  await fixture(async (root) => {
    const source = path.join(root, "skill"), cwd = path.join(root, "workspace"), home = path.join(root, "home");
    await Promise.all([source, cwd, home].map((directory) => mkdir(directory)));
    await writeFile(path.join(source, "SKILL.md"), await readFile(path.join(root, "SKILL.md")));
    await fn({ source, cwd, home, root });
  });
}
async function artifact(file, content = "synthetic prior-session data") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test("residue inspection covers caches, temp files, outputs and persisted state inside a Skill", async () => residueFixture(async ({ source, cwd, home }) => {
  const residue = ["tmp/session.txt", ".cache/data.bin", "outputs/result.json", "state.json", "history.sqlite", "session-state.json", "trace.log", "old.tmp"];
  const assets = ["references/guide.md", "assets/input.json", "scripts/helper.py", "templates/config.json"];
  await Promise.all([...residue, ...assets].map((relative) => artifact(path.join(source, relative))));
  const before = await readFile(path.join(source, "tmp/session.txt"));
  const checked = (await auditSkill({ source }, { cwd, home })).cross_session_residue;
  assert.equal(checked.status, "findings");
  assert.equal(checked.findings.length, residue.length);
  assert.ok(checked.findings.every((finding) => finding.reason === "residue_candidate" && finding.provenance === "unknown"));
  assert.deepEqual(await readFile(path.join(source, "tmp/session.txt")), before);
  assert.ok(REQUIRED_CHECKS.some((check) => check.id === checked.id && check.required));
}));

test("declared workspace/home reads and writes expose existing residue and future external writes", async () => residueFixture(async ({ source, cwd, home }) => {
  await artifact(path.join(home, ".cache/agent/state.json"));
  await artifact(path.join(cwd, "tmp/session.tmp"));
  await artifact(path.join(source, "assets/input.json"));
  const checked = (await auditSkill({ source,
    reads: ["~/.cache/agent/state.json", "${WORKSPACE}/tmp/session.tmp", "$SKILL_DIR/assets/input.json", "$WORKSPACE/missing.json"],
    writes: ["$HOME/.cache/agent/state.json", "$CWD/tmp/session.tmp", "$WORKSPACE/future.json"]
  }, { cwd, home })).cross_session_residue;
  assert.equal(checked.findings.filter((finding) => finding.reason === "outside_skill_write").length, 3);
  assert.equal(checked.findings.filter((finding) => finding.reason === "persisted_state_read").length, 2);
  const future = checked.findings.find((finding) => finding.path === path.join(cwd, "future.json"));
  assert.equal(future.exists, false);
  assert.equal(future.outsideSkill, true);
  await assert.rejects(access(path.join(cwd, "future.json")), { code: "ENOENT" });
  assert.equal(checked.limitations.length, 0);
}));

test("reuse of a declared internal write target is persistent state even with an ordinary filename", async () => residueFixture(async ({ source, cwd, home }) => {
  await artifact(path.join(source, "record.json"));
  const checked = (await auditSkill({ source, reads: ["record.json"], writes: ["./record.json"] }, { cwd, home })).cross_session_residue;
  assert.equal(checked.findings.length, 2);
  assert.ok(checked.findings.some((finding) => finding.reason === "persisted_state_read"));
  assert.equal(checked.findings[0].outsideSkill, false);
}));

test("declared directory outputs identify state read from files under that directory", async () => residueFixture(async ({ source, cwd, home }) => {
  await artifact(path.join(source, "data/record.txt"));
  const checked = (await auditSkill({ source, reads: ["data/record.txt"], writes: ["./data/"] }, { cwd, home })).cross_session_residue;
  assert.ok(checked.findings.some((finding) => finding.reason === "persisted_state_read" && finding.path === path.join(source, "data/record.txt")));
}));

test("outside write detection resolves symlink ancestors and respects directory boundaries", async () => residueFixture(async ({ source, cwd, home, root }) => {
  await symlink(cwd, path.join(source, "linked"), "dir");
  const checked = (await auditSkill({ source, writes: ["./linked/new/result.json", "../skill-other/output.json"] }, { cwd, home })).cross_session_residue;
  const external = checked.findings.filter((finding) => finding.reason === "outside_skill_write");
  assert.deepEqual(external.map((finding) => finding.path), [path.join(cwd, "new/result.json"), path.join(root, "skill-other/output.json")]);
  assert.ok(checked.limitations.some((item) => item.reason === "uninspected_special_file"));
  assert.equal((await auditSkill({ source, reads: ["$UNKNOWN/state.json", "outputs/*.json", "source-code"] }, { cwd, home })).cross_session_residue.limitations.filter((item) => item.reason === "unresolved_declared_target").length, 3);
}));

test("a clean artifact tree passes scoped residue inspection and unavailable evidence stays unknown", async () => residueFixture(async ({ source, cwd, home }) => {
  await artifact(path.join(source, "assets/input.json"));
  assert.equal((await auditSkill({ source, reads: ["assets/input.json"] }, { cwd, home })).cross_session_residue.status, "pass");
  assert.equal((await auditSkill({ source, writes: ["$UNKNOWN/data.json"] }, { cwd, home })).cross_session_residue.status, "unknown");
  assert.equal((await auditSkill({ source, metadataError: "invalid" }, { cwd, home })).cross_session_residue.status, "unknown");
  const synthetic = await auditSkill({ source: "openclaw:runtime" });
  assert.ok(REQUIRED_CHECKS.every(({ id }) => synthetic[id].status === "unknown"));
  const old = analyzeInventory({ components: [{ id: "old", kind: "skill", name: "old", description: "cached" }] });
  assert.ok(old.requiredChecks.every((check) => check.unknownSkills === 1));
}));

test("scanner runs both mandatory checks, scopes shared targets and does not discover residue as Skills", async () => residueFixture(async ({ source, cwd, home }) => {
  await artifact(path.join(source, "tmp/SKILL.md"), "---\nname: leftover\n---\n");
  await artifact(path.join(cwd, "outputs/result.json"));
  await writeFile(path.join(source, "SKILL.md"), "---\nname: audit-fixture\ndescription: fixture\nreads: ['$WORKSPACE/outputs/result.json']\nwrites: ['$WORKSPACE/outputs/result.json']\n---\n");
  const inventory = await scanRoots({ roots: [source], runtime: "hermes", cwd, home });
  assert.deepEqual(inventory.components.map((component) => component.name), ["audit-fixture"]);
  const analysis = analyzeInventory(inventory);
  assert.equal(analysis.requiredChecks.length, 2);
  assert.equal(analysis.requiredChecks.find((check) => check.id === "python_bytecode").status, "pass");
  assert.equal(analysis.requiredChecks.find((check) => check.id === "cross_session_residue").status, "findings");
  assert.equal(analysis.actionableFindings.filter((finding) => finding.type === "cross_session_residue").length, 3);
  assert.match(formatAnalysis(analysis), /Required check: cross_session_residue=findings/);
}));

test("CLI analysis reports mandatory evidence without saving state or executing Skill code", async () => residueFixture(async ({ source, cwd, home, root }) => {
  await artifact(path.join(source, "outputs/prior.txt"));
  const state = path.join(root, "state-must-not-exist");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const args = [cli, "analyze", "--runtime", "hermes", "--root", source, "--state", state];
  const { stdout } = await exec(process.execPath, [...args, "--json"], { cwd, env: { ...process.env, HOME: home } });
  const analysis = JSON.parse(stdout);
  assert.ok(analysis.requiredChecks.every((check) => check.required));
  assert.equal(analysis.findingCountsByType.cross_session_residue, 1);
  const human = await exec(process.execPath, args, { cwd });
  assert.match(human.stdout, /Required check: cross_session_residue=findings/);
  await assert.rejects(access(state), { code: "ENOENT" });
}));
