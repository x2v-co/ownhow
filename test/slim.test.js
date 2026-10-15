import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSlim, applySlim, estimateTokens, planSlimApply, restoreSlim } from "../src/slim.js";
import { scanRoots } from "../src/scanner.js";
import { resolveTask } from "../src/resolver.js";
import { appendReceipt, loadSkillAllowlists, readJson, updateSkillAllowlist, writeJson } from "../src/store.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/home/", import.meta.url));
const now = Date.parse("2026-10-15T12:00:00Z");
const skill = (id, extra = {}) => ({ id, name: id, kind: "skill", runtime: "hermes", description: `${id} specialized procedure`, metadata: {}, triggers: [], tools: [], writes: [], sideEffects: [], ...extra });
const inventory = (components, extra = {}) => ({ runtime: "hermes", generatedAt: new Date(now).toISOString(), components, ...extra });
const receipt = (id, date, extra = {}) => ({ runtime: "hermes", createdAt: date, plan: { primary: id, augment: [] }, ...extra });

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ownhow-slim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function installed(t) {
  const root = await temporary(t);
  const hermesHome = path.join(root, ".hermes");
  const skillsRoot = path.join(hermesHome, "skills");
  const bodies = {};
  for (const name of ["keep", "disable"]) {
    await mkdir(path.join(skillsRoot, name), { recursive: true });
    bodies[name] = `---\nname: ${name}\ndescription: ${name} specialized procedure\n---\n\n# ${name}\n`;
    await writeFile(path.join(skillsRoot, name, "SKILL.md"), bodies[name]);
    await writeFile(path.join(skillsRoot, name, "support.txt"), `support for ${name}`);
  }
  const state = path.join(root, "state");
  const scan = () => scanRoots({ roots: [skillsRoot], runtime: "hermes", hermesHome });
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, "slim", ...args, "--runtime", "hermes", "--state", state, "--json"], { env: { ...process.env, HERMES_HOME: hermesHome } })).stdout);
  return { root, hermesHome, skillsRoot, state, scan, run, bodies };
}

test("usage needs dated per-Skill evidence; absent evidence stays unknown", async () => {
  const items = ["old", "recent", "missing", "retrospective", "explicit-false", "foreign", "remote", "invalid", "future", "augmentation"].map((id) => skill(id));
  items.push(skill("reported", { lifecycle: { actualUsed: true } }), skill("reported-false", { lifecycle: { actualUsed: false } }));
  const receipts = [
    receipt("old", "2026-08-01"), receipt("recent", "2026-10-10"),
    receipt("retrospective", "2026-10-10", { execution: { attribution: "retrospective-resolution" } }),
    receipt("explicit-false", "2026-10-10", { governance: { actualUsed: false } }),
    receipt("foreign", "2026-10-10", { runtime: "codex" }),
    receipt("remote", "2026-10-10", { provenance: { source: "remote" } }),
    receipt("invalid", "not a date"), receipt("future", "2099-01-01"),
    receipt("another", "2026-10-10", { plan: { primary: "another", augment: ["augmentation"] } })
  ];
  const report = await analyzeSlim(inventory(items), receipts, { now, unusedDays: 30 });
  const byName = Object.fromEntries(report.skills.map((item) => [item.name, item]));
  assert.equal(byName.old.usage.status, "unused");
  assert.ok(byName.old.flags.includes("unused"));
  assert.equal(byName.old.suggested, false);
  for (const id of ["recent", "reported", "augmentation"]) assert.equal(byName[id].usage.status, "used", id);
  for (const id of ["missing", "retrospective", "explicit-false", "foreign", "remote", "invalid", "future", "reported-false"]) {
    assert.equal(byName[id].usage.status, "unknown", id);
    assert.ok(!byName[id].flags.includes("unused"));
  }
  const stale = await analyzeSlim(inventory([items.at(-2)], { generatedAt: "2026-08-01" }), [], { now });
  assert.equal(stale.skills[0].usage.status, "unused");
  const confirmed = await analyzeSlim(inventory([skill("actual")]), [receipt("actual", "2026-10-10", { execution: { attribution: "retrospective-resolution" }, governance: { actualUsed: true } })], { now });
  assert.equal(confirmed.skills[0].usage.status, "used");
});

test("reuses analyzer semantic overlap and duplicate names for conservative suggestions", async () => {
  const description = "astronomy telescope photometry calibration spectroscopy";
  const components = [skill("a", { name: "same", description }), skill("b", { name: "same", description }), skill("c", { description }), skill("unique", { description: "baking sourdough fermentation" })];
  const report = await analyzeSlim(inventory(components), [receipt("a", "2026-10-10")], { now });
  assert.deepEqual(report.suggested.map((item) => item.id).sort(), ["a", "unique"]);
  assert.ok(report.skills.find((item) => item.id === "b").overlaps.some((finding) => finding.type === "duplicate_name"));
  assert.ok(report.skills.find((item) => item.id === "c").overlaps.some((finding) => finding.type === "semantic_overlap"));
  assert.ok(report.skills.every((item) => item.reasons.length));
  const copies = await analyzeSlim(inventory([skill("hermes", { name: "copy", description }), skill("codex", { name: "copy", runtime: "codex", description })], { runtime: "all" }), [], { now });
  assert.equal(copies.suggested.length, 2);
  assert.ok(copies.skills.every((item) => !item.flags.includes("overlapping")));
});

test("estimates whole SKILL.md and description tokens, including unavailable sources", async (t) => {
  const root = await temporary(t);
  const body = `---\nname: large\ndescription: tiny\n---\n${"detail ".repeat(300)}`;
  await writeFile(path.join(root, "SKILL.md"), body);
  const report = await analyzeSlim(inventory([
    skill("large", { source: root, description: "tiny" }),
    skill("synthetic", { source: "openclaw:runtime", description: "界".repeat(300) }),
    skill("unavailable", { source: path.join(root, "missing"), description: "tiny" })
  ]), [], { now, maxTokens: 100 });
  assert.equal(report.skills[0].tokens.skillTokens, estimateTokens(body));
  assert.ok(report.skills[0].flags.includes("oversized"));
  assert.ok(report.skills[1].flags.includes("oversized"));
  assert.equal(report.skills[2].tokens.skillTokens, null);
  assert.equal(report.skills[2].usage.status, "unknown");
  assert.match(report.skills[0].reasons.join(" "), /shorten/);
  for (const value of [0, -1, "bad", Infinity]) await assert.rejects(analyzeSlim(inventory([]), [], { maxTokens: value }), /positive/);
  await assert.rejects(analyzeSlim(inventory([]), [], { unusedDays: "bad" }), /positive/);
});

test("allowlists persist per runtime and resolve filters primary and augment candidates", async (t) => {
  const state = path.join(await temporary(t), "state");
  const components = [skill("a", { name: "astronomy", description: "telescope photometry calibration" }), skill("b", { name: "augment", description: "telescope photometry calibration", metadata: { augments: ["astronomy"] } })];
  const input = inventory(components);
  assert.equal(resolveTask(input, "astronomy").primary.id, "a");
  assert.deepEqual(await loadSkillAllowlists(state), {});
  await assert.rejects(access(state));
  await updateSkillAllowlist(state, "hermes", "allow", ["astronomy", "astronomy", "uninstalled"]);
  await updateSkillAllowlist(state, "codex", "allow", ["different"]);
  let allowlists = await loadSkillAllowlists(state);
  assert.deepEqual(allowlists.hermes, ["astronomy", "uninstalled"]);
  const plan = resolveTask(input, "telescope photometry calibration", [], { allowlists });
  assert.equal(plan.primary.id, "a");
  assert.equal(plan.candidateCount, 1);
  assert.deepEqual(plan.augment, []);
  assert.deepEqual(plan.excluded, []);
  await updateSkillAllowlist(state, "hermes", "deny", ["astronomy", "uninstalled"]);
  allowlists = await loadSkillAllowlists(state);
  assert.deepEqual(allowlists.hermes, []);
  assert.equal(resolveTask(input, "astronomy", [], { allowlists }).primary, null);
  const report = await analyzeSlim(input, [], { allowlists, now });
  assert.equal(report.suggested.length, 0);
  assert.equal(resolveTask({ ...input, runtime: "claude" }, "astronomy", [], { allowlists }).primary.id, "a");
  await assert.rejects(updateSkillAllowlist(state, "all", "allow", ["a"]), /concrete runtime/);
  await assert.rejects(updateSkillAllowlist(state, "hermes", "allow", []), /one or more/);
});

test("all-runtime resolve applies each runtime's list and leaves missing lists unrestricted", () => {
  const items = [skill("a", { name: "astronomy" }), skill("b", { runtime: "codex", name: "astronomy" }), skill("c", { runtime: "claude", name: "astronomy" })];
  const plan = resolveTask(inventory(items, { runtime: "all" }), "astronomy", [], { allowlists: { hermes: [], codex: ["astronomy"] } });
  assert.equal(plan.candidateCount, 2);
  assert.ok(plan.primary.id !== "a");
});

test("slimming keeps runtime selections independent when shared roots produce identical IDs", async () => {
  const description = "astronomy telescope photometry calibration spectroscopy";
  const items = ["codex", "pi"].flatMap((runtime) => [skill("shared-a", { runtime, description }), skill("shared-b", { runtime, description })]);
  const report = await analyzeSlim(inventory(items, { runtime: "all" }), [], { now });
  assert.equal(report.suggested.length, 2);
  assert.deepEqual(report.suggested.map((item) => item.runtime).sort(), ["codex", "pi"]);
});

test("CLI analysis is read-only and finds overlap using existing fixture patterns", async (t) => {
  const state = path.join(await temporary(t), "absent");
  const args = [cli, "slim", "--runtime", "codex", "--root", path.join(fixtures, ".codex", "plugins"), "--root", path.join(fixtures, ".agents", "skills"), "--state", state];
  const result = JSON.parse((await exec(process.execPath, [...args, "--json"])).stdout);
  assert.equal(result.dryRun, true);
  assert.equal(result.skills.length, 2);
  assert.ok(result.skills.every((item) => item.usage.status === "unknown"));
  assert.ok(result.skills.some((item) => item.flags.includes("overlapping")));
  await assert.rejects(access(state));
  assert.match((await exec(process.execPath, args)).stdout, /dry run/);
});

test("CLI allow/deny/list selection is honored by resolve with live and cached inventories", async (t) => {
  const { state, skillsRoot, run, scan } = await installed(t);
  assert.deepEqual(await run("list"), { allowlists: {} });
  await run("allow", "keep", "disable");
  await run("deny", "keep");
  assert.deepEqual((await run("list")).allowlists, { hermes: ["disable"] });
  const scanned = await scan();
  await appendReceipt(state, receipt(scanned.components.find((item) => item.name === "keep").id, "2026-10-10"));
  const args = [cli, "resolve", "keep", "--runtime", "hermes", "--state", state, "--json"];
  assert.equal(JSON.parse((await exec(process.execPath, [...args, "--root", skillsRoot])).stdout).primary, null);
  await exec(process.execPath, [cli, "scan", "--runtime", "hermes", "--root", skillsRoot, "--state", state]);
  assert.equal(JSON.parse((await exec(process.execPath, [...args, "--cached"])).stdout).candidateCount, 1);
  const unfiltered = JSON.parse((await exec(process.execPath, [cli, "resolve", "keep", "--runtime", "codex", "--root", skillsRoot, "--state", state, "--json"])).stdout);
  assert.equal(unfiltered.primary.name, "keep");
});

test("CLI apply and restore require --write and preserve Skill and support bytes", async (t) => {
  const { hermesHome, skillsRoot, state, run, scan, bodies } = await installed(t);
  await run("allow", "keep");
  const dry = await run("apply");
  assert.equal(dry.dryRun, true);
  assert.equal(dry.enforcement, "supported");
  assert.equal(dry.changes.length, 1);
  await assert.rejects(access(path.join(state, "slim", "moves")));
  assert.equal((await scan()).components.length, 2);
  const applied = await run("apply", "--write");
  assert.equal(applied.dryRun, false);
  await assert.rejects(access(path.join(skillsRoot, "disable")));
  assert.equal(await readFile(path.join(applied.changes[0].to, "SKILL.md"), "utf8"), bodies.disable);
  assert.deepEqual((await scan()).components.map((item) => item.name), ["keep"]);
  const broad = await scanRoots({ roots: [hermesHome], runtime: "hermes", hermesHome });
  assert.ok(!broad.components.some((item) => item.name === "disable"));
  assert.equal((await run("apply", "--write")).changes.length, 0);
  assert.equal((await run("restore")).dryRun, true);
  await assert.rejects(access(path.join(skillsRoot, "disable")));
  const restored = await run("restore", "--write");
  assert.equal(restored.changes.length, 1);
  assert.equal(await readFile(path.join(skillsRoot, "disable", "SKILL.md"), "utf8"), bodies.disable);
  assert.equal(await readFile(path.join(skillsRoot, "disable", "support.txt"), "utf8"), "support for disable");
  assert.equal((await run("restore", "--write")).changes.length, 0);
  assert.deepEqual((await run("list")).allowlists.hermes, ["keep"]);
});

test("restore refuses to overwrite a replacement and retains the disabled original", async (t) => {
  const { skillsRoot, state, run } = await installed(t);
  await run("allow", "keep");
  const applied = await run("apply", "--write");
  await mkdir(path.join(skillsRoot, "disable"));
  await writeFile(path.join(skillsRoot, "disable", "replacement"), "new");
  await assert.rejects(restoreSlim(state, "hermes", { write: true }), /Refusing to overwrite/);
  await access(path.join(applied.changes[0].to, "SKILL.md"));
  assert.equal(await readFile(path.join(skillsRoot, "disable", "replacement"), "utf8"), "new");
});

test("journals recover interrupted apply and restore", async (t) => {
  const { state, run } = await installed(t);
  await run("allow", "keep");
  const applied = await run("apply", "--write");
  const directory = path.join(state, "slim", "moves", "hermes");
  const journal = path.join(directory, (await readdir(directory))[0]);
  const entry = await readJson(journal);
  await writeJson(journal, { ...entry, status: "pending" });
  assert.equal((await restoreSlim(state, "hermes")).changes.length, 1);
  await writeJson(journal, { ...entry, status: "restoring" });
  await rename(applied.changes[0].to, applied.changes[0].from);
  assert.equal((await restoreSlim(state, "hermes", { write: true })).recovered.length, 1);
  assert.equal((await readJson(journal)).status, "restored");
});

test("unsupported runtimes, plugins, shared/custom paths, and links are never moved", async (t) => {
  const { root, state, hermesHome, skillsRoot, scan } = await installed(t);
  const scanned = await scan();
  const unsupported = await planSlimApply({ ...scanned, runtime: "openclaw" }, { openclaw: [] });
  assert.equal(unsupported.enforcement, "unsupported");
  assert.equal(unsupported.changes.length, 0);
  assert.equal(unsupported.unsupported.length, 2);
  assert.deepEqual((await applySlim(state, unsupported, { write: true })).allowlist, []);
  await assert.rejects(access(state));
  const components = scanned.components.map((item) => ({ ...item, plugin: "package" }));
  assert.equal((await planSlimApply({ ...scanned, components }, { hermes: [] }, { hermesHome })).changes.length, 0);
  const custom = await planSlimApply({ ...scanned, runtime: "codex" }, { codex: [] }, { home: root });
  assert.equal(custom.changes.length, 0);
  const external = path.join(root, "external");
  await mkdir(external);
  await writeFile(path.join(external, "SKILL.md"), "---\nname: linked\ndescription: external\n---\n");
  await symlink(external, path.join(skillsRoot, "linked"), "dir");
  const links = await planSlimApply(await scan(), { hermes: ["keep", "disable"] }, { hermesHome });
  assert.equal(links.changes.length, 0);
  assert.equal(links.unsupported[0].name, "linked");
});

test("private Codex and Claude standalone directories support reversible moves", async (t) => {
  const home = await temporary(t);
  for (const runtime of ["codex", "claude"]) {
    const source = path.join(home, `.${runtime}`, "skills", "private");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: private\ndescription: private procedure\n---\n");
    const scanned = await scanRoots({ roots: [path.dirname(source)], runtime, home });
    const plan = await planSlimApply(scanned, { [runtime]: [] }, { home });
    assert.equal(plan.enforcement, "supported");
    assert.equal(plan.changes.length, 1);
    const state = path.join(home, "state");
    await applySlim(state, plan, { write: true });
    await restoreSlim(state, runtime, { write: true });
    await access(path.join(source, "SKILL.md"));
  }
});

test("CLI rejects deletion, invalid thresholds, aggregate mutations, and non-live apply", async (t) => {
  const { state, run } = await installed(t);
  await assert.rejects(run("delete"), /Deletion is not supported/);
  await assert.rejects(run("allow"), /one or more/);
  await assert.rejects(run("--unused-days", "invalid"), /positive/);
  await assert.rejects(run("apply"), /No allowlist/);
  await assert.rejects(run("apply", "--cached"), /live filesystem scan/);
  await assert.rejects(run("apply", "--write=false"), /boolean flag/);
  await assert.rejects(run("--write"), /only supported/);
  await assert.rejects(exec(process.execPath, [cli, "slim", "allow", "skill", "--runtime", "all", "--state", state]), /concrete runtime/);
  await assert.rejects(restoreSlim(state, "all"), /concrete/);
});
