import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
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
  assert.equal((await bytecode(root)).status, "pass");
  await timestampCache(root, "module.pyc", { flags: 2, mtime: 1700000001 });
  assert.equal((await bytecode(root)).findings[0].reason, "timestamp_size_mismatch");
  await timestampCache(root, "module.pyc", { flags: 4 });
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

test("foreign hash versions stay unknown and the hash helper ignores Skill imports", async (t) => {
  if (!await requirePython(t)) return;
  await fixture(async (root) => {
    await artifact(path.join(root, "json.py"), "open('executed', 'w').write('bad')\n");
    await exec("python3", ["-I", "-S", "-c", "import py_compile; py_compile.compile('module.py', cfile='module.pyc', invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)"], { cwd: root });
    const moduleUrl = new URL("../src/audit-checks.js", import.meta.url).href;
    const script = `import { auditSkill } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await auditSkill({source: process.argv[1]})));`;
    const isolated = await exec(process.execPath, ["--input-type=module", "-e", script, root], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
    assert.equal(JSON.parse(isolated.stdout).python_bytecode.status, "pass");
    await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
    const unavailable = await exec(process.execPath, ["--input-type=module", "-e", script, root], { env: { ...process.env, PATH: "" } });
    assert.equal(JSON.parse(unavailable.stdout).python_bytecode.limitations[0].reason, "hash_verifier_unavailable");
    const cache = await readFile(path.join(root, "module.pyc"));
    cache.writeUInt16LE(cache.readUInt16LE(0) + 1, 0);
    await writeFile(path.join(root, "module.pyc"), cache);
    const foreign = await bytecode(root);
    assert.equal(foreign.status, "unknown");
    assert.equal(foreign.limitations[0].reason, "unsupported_hash_version");
  });
});

test("artifact traversal and source-size limits keep mandatory evidence incomplete", async () => fixture(async (root) => {
  await timestampCache(root, "module.pyc", { flags: 1 });
  await truncate(path.join(root, "module.py"), 8 * 1024 * 1024 + 1);
  const large = await bytecode(root, { hashSource: async () => { throw new Error("Oversized source must not reach hashing"); } });
  assert.equal(large.status, "unknown");
  assert.equal(large.limitations[0].reason, "source_size_limit");
  await artifact(path.join(root, ...Array.from({ length: 34 }, () => "nested"), "hidden.pyc"));
  const checked = await auditSkill({ source: root });
  assert.ok(REQUIRED_CHECKS.every(({ id }) => checked[id].limitations.some((item) => item.reason === "scan_limit")));
}));

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
  assert.equal(analysis.requiredChecks.length, REQUIRED_CHECKS.length);
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

const permissionRoot = new URL("./fixtures/permission-risk/", import.meta.url).pathname;
const permissionIds = ["self_log_tampering", "external_network_access", "cross_agent_communication"];

test("required permission checks inspect runtime scripts, declarations and enclosing plugin manifests", async () => {
  const layouts = [
    ["claude-plugin/skills/review", "claude"], ["hermes/skills/network", "hermes"],
    ["pi-package/skills/network", "pi"], ["opencode/.opencode/skills/review", "opencode"], ["openclaw/skills/review", "openclaw"]
  ];
  for (const [relative, runtime] of layouts) {
    const source = path.join(permissionRoot, relative);
    const inventory = await scanRoots({ roots: [source], runtime, cwd: source, home: permissionRoot });
    const skill = inventory.components.find((item) => item.kind === "skill");
    for (const id of permissionIds) {
      const check = skill.auditChecks[id];
      if (relative.startsWith("opencode") && id === "self_log_tampering") continue;
      assert.equal(check.status, "findings", `${relative}: ${id}`);
      for (const finding of check.findings) {
        assert.ok(["high", "medium", "low"].includes(finding.risk));
        assert.equal(finding.severity, finding.risk === "low" ? "info" : finding.risk);
        assert.ok(path.isAbsolute(finding.path));
        assert.ok(finding.line > 0);
        assert.ok(finding.evidence.length > 0 && finding.evidence.length <= 200);
        assert.ok(finding.reason && finding.message);
        const line = (await readFile(finding.path, "utf8")).split(/\r?\n/)[finding.line - 1];
        assert.equal(finding.evidence, line.trim().slice(0, 200));
      }
    }
    const network = skill.auditChecks.external_network_access;
    if (["claude", "opencode", "openclaw"].includes(runtime)) assert.ok(network.findings.some((item) => item.reason === "remote_server_url" && !item.path.startsWith(`${source}/`)));
    const analysis = analyzeInventory(inventory);
    assert.equal(analysis.permissionBlocked, false);
    assert.ok(analysis.requiredChecks.filter((item) => permissionIds.includes(item.id)).every((item) => item.mode === "warn"));
    assert.match(formatAnalysis(analysis), /Required check: external_network_access=findings/);
  }
});

test("Claude plugin-root discovery includes its remote MCP manifest", async () => {
  const source = path.join(permissionRoot, "claude-plugin");
  const inventory = await scanRoots({ roots: [source], runtime: "claude", cwd: source, home: permissionRoot });
  const skill = inventory.components.find((item) => item.kind === "skill");
  assert.equal(skill.pluginRoot, source);
  assert.ok(skill.auditChecks.external_network_access.findings.some((item) => item.path === path.join(source, ".mcp.json") && item.line === 3));
});

test("clean local operations have no permission findings; prose and fenced examples have lower risk", async () => {
  const clean = await auditSkill({ source: path.join(permissionRoot, "clean") });
  for (const id of permissionIds) assert.equal(clean[id].status, "pass");
  const prose = await auditSkill({ source: path.join(permissionRoot, "prose") });
  for (const id of permissionIds) assert.ok(prose[id].findings.some((item) => item.risk === "low" && item.severity === "info"));
  assert.ok(prose.external_network_access.findings.some((item) => item.risk === "medium"));
});

test("permission detection covers network APIs, agent tools and log mutation across script languages", async () => fixture(async (root) => {
  const groups = {
    self_log_tampering: ["fs.unlink('file.log')", "fs.writeFile('audit.txt', '')", "File.write('history.jsonl', '')", "os.remove('receipts.json')", "open('history.jsonl', 'w')", "rm ownhow/receipts.jsonl", "truncate -s0 trace.log", "sed -i 's/a/b/' audit.txt", ": > transcript.txt", "history -c", "git commit --amend", "git reflog expire --all"],
    external_network_access: ["curl https://example.test", "wget https://example.test", "nc example.test 80", "ssh user@example.test", "scp a user@example.test:/a", "fetch('https://example.test')", "axios.get(url)", "requests.get(url)", "urllib.request.urlopen(url)", "httpx.get(url)", "aiohttp.ClientSession()", "http.client.HTTPSConnection(host)", 'import "net/http"'],
    cross_agent_communication: ["SendToAgent('other')", "send_message('other')", "spawn sub-agents", "claude -p 'hello'", "codex exec hello", "opencode run hello", "pi -p hello", "hermes chat", "GET /.well-known/agent.json", "A2A agent card", "echo hello > ~/.claude/agents/inbox.txt", "fs.writeFile('../agents/inbox.txt', 'hello')", "cp message.txt ~/.pi/agent/inbox.txt", "mkdir ~/.openclaw/agents/shared"]
  };
  for (const [id, lines] of Object.entries(groups)) {
    await writeFile(path.join(root, "cases.ts"), lines.join("\n"));
    const check = (await auditSkill({ source: root }))[id];
    assert.equal(check.findings.filter((item) => item.path.endsWith("cases.ts")).length, lines.length, id);
    assert.ok(check.findings.every((item) => item.risk === "high"));
  }
}));

test("permission inspection caps text reads, skips binaries and never executes scripts", async () => fixture(async (root) => {
  await writeFile(path.join(root, "large.js"), "x".repeat(1024 * 1024 + 1));
  await writeFile(path.join(root, "binary.js"), Buffer.from("\0curl https://example.test"));
  await writeFile(path.join(root, "run"), "#!/bin/sh\ncurl https://example.test\ntouch executed\n");
  await symlink(path.join(root, "run"), path.join(root, "linked.sh"));
  const checked = await auditSkill({ source: root });
  for (const id of permissionIds) {
    assert.ok(checked[id].limitations.some((item) => item.reason === "permission_file_size_limit"));
    assert.ok(checked[id].limitations.some((item) => item.reason === "uninspected_special_file"));
    assert.ok(!checked[id].findings.some((item) => item.path.endsWith("binary.js")));
  }
  assert.ok(checked.external_network_access.findings.some((item) => item.path.endsWith("/run")));
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
}));

test("permission policy applies off, warn, block and exact Skill allowlists to cached evidence", async () => {
  const source = path.join(permissionRoot, "hermes/skills/network");
  const inventory = await scanRoots({ roots: [source], runtime: "hermes", home: permissionRoot, cwd: source });
  const skill = inventory.components[0];
  const off = analyzeInventory(inventory, { mode: "off" });
  assert.ok(off.requiredChecks.filter((check) => permissionIds.includes(check.id)).every((check) => check.status === "skipped" && check.skippedSkills === 1));
  assert.ok(off.findings.every((item) => !permissionIds.includes(item.type)));
  assert.equal(off.permissionBlocked, false);
  assert.equal(analyzeInventory(inventory, { mode: "warn" }).permissionBlocked, false);
  const block = analyzeInventory(inventory, { mode: "off", overrides: ["external_network_access=block"] });
  assert.equal(block.permissionBlocked, true);
  assert.deepEqual(block.blockedPermissionChecks, ["external_network_access"]);
  assert.match(formatAnalysis(block), /Permission policy blocked: external_network_access/);
  assert.match(formatAnalysis(block), /mode=block/);
  assert.equal(analyzeInventory(inventory, { mode: "block", allowSkills: [skill.id] }).permissionBlocked, false);
  assert.equal(analyzeInventory(inventory, { mode: "block", allowSkills: [skill.name] }).permissionBlocked, true);
  assert.throws(() => analyzeInventory(inventory, { mode: "oops" }), /Invalid permission check policy/);
  assert.throws(() => analyzeInventory(inventory, { overrides: ["python_bytecode=off"] }), /Invalid permission check policy/);
  assert.equal(analyzeInventory({ components: [] }, { mode: "off" }).requiredChecks.find((check) => check.id === permissionIds[0]).status, "skipped");
  const cached = structuredClone(inventory);
  delete cached.components[0].auditChecks;
  assert.equal(analyzeInventory(cached, { mode: "block" }).permissionBlocked, false);
  assert.ok(analyzeInventory(cached).requiredChecks.every((check) => check.status === "unknown"));
});

test("CLI permission flags and environment affect analyze exit codes without executing scanned content", async () => {
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const source = path.join(permissionRoot, "hermes/skills/network");
  const args = [cli, "analyze", "--runtime", "hermes", "--root", source, "--json"];
  const env = { ...process.env, OWNHOW_PERMISSION_CHECKS: "warn" };
  assert.equal(JSON.parse((await exec(process.execPath, args, { env })).stdout).permissionBlocked, false);
  for (const [flags, variable] of [
    [["--permission-checks=block"], "warn"],
    [["--permission-checks", "off", "--permission-check", "external_network_access=block"], "warn"],
    [[], "block"], [[], "external_network_access=block,self_log_tampering=off"],
    [["--permission-check=external_network_access=block"], "warn"]
  ]) {
    await assert.rejects(exec(process.execPath, [...args, ...flags], { env: { ...env, OWNHOW_PERMISSION_CHECKS: variable } }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).permissionBlocked, true);
      return true;
    });
  }
  const off = JSON.parse((await exec(process.execPath, [...args, "--permission-checks=off"], { env: { ...env, OWNHOW_PERMISSION_CHECKS: "block" } })).stdout);
  assert.ok(off.requiredChecks.filter((check) => permissionIds.includes(check.id)).every((check) => check.status === "skipped"));
  const initial = JSON.parse((await exec(process.execPath, args, { env })).stdout);
  const id = initial.requiredChecks.find((check) => check.id === "external_network_access").results[0].componentId;
  const allowed = JSON.parse((await exec(process.execPath, [...args, "--permission-checks=block", `--permission-allow-skill=${id}`], { env })).stdout);
  assert.equal(allowed.permissionBlocked, false);
  await assert.rejects(exec(process.execPath, [...args, "--permission-checks=invalid"], { env }), /Invalid permission check policy/);
});


test("declarations cover agent home directories and network effects without misreading package links", async () => fixture(async (root) => {
  const homes = [".claude", ".codex", ".hermes", ".pi", ".config/opencode", ".openclaw"];
  const source = path.join(root, "skills", "review");
  await artifact(path.join(source, "SKILL.md"), `---\nname: declaration-fixture\nallowed-tools:\n  - Task\n  - Agent\n  - WebFetch\nside_effects: [network_access]\nwrites:\n${homes.map((name) => `  - '~/${name}'`).join("\n")}\n---\nUse the Task tool.\n`);
  await artifact(path.join(root, "package.json"), JSON.stringify({ pi: { skills: ["./skills"] }, bugs: { url: "https://example.test/issues" }, mcpServers: { actual: { url: "https://example.test/mcp" } } }, null, 2));
  const checked = await auditSkill({ source }, { home: root, cwd: root });
  assert.equal(checked.cross_agent_communication.findings.filter((item) => item.reason === "declared_agent_write").length, homes.length);
  assert.equal(checked.cross_agent_communication.findings.filter((item) => item.reason === "declared_agent_tool").length, 2);
  assert.ok(checked.cross_agent_communication.findings.some((item) => item.risk === "low"));
  assert.ok(checked.external_network_access.findings.some((item) => item.reason === "declared_network_effect"));
  const urls = checked.external_network_access.findings.filter((item) => item.reason === "remote_server_url");
  assert.equal(urls.length, 1);
  assert.match(urls[0].evidence, /example.test\/mcp/);
}));

test("a symlinked plugin manifest directory remains an explicit limitation", async () => fixture(async (root) => {
  const source = path.join(root, "skills", "review");
  await artifact(path.join(source, "SKILL.md"), "---\nname: linked-manifest\n---\n");
  const outside = path.join(root, "outside");
  await artifact(path.join(outside, "plugin.json"), '{"url":"https://example.test/mcp"}');
  await symlink(outside, path.join(root, ".claude-plugin"), "dir");
  const checked = await auditSkill({ source, pluginRoot: root });
  for (const id of permissionIds) {
    assert.equal(checked[id].status, "unknown");
    assert.ok(checked[id].limitations.some((item) => item.reason === "uninspected_special_file"));
  }
}));
