import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadSessionManifest, normalizeSessionManifest, summarizeLifecycle } from "../src/session-manifest.js";

test("normalizes the legacy skillFiles manifest and deduplicates absolute paths", () => {
  const file = path.resolve("/tmp/ownhow-session/SKILL.md");
  const manifest = normalizeSessionManifest({ runtime: "skywork", skillFiles: [file, file] }, { runtime: "skywork" });
  assert.deepEqual(manifest.skillFiles, [file]);
  assert.deepEqual(manifest.syntheticSkills, []);
  assert.equal(manifest.schemaVersion, "0");
});

test("accepts schema v1 pathless host Skills and rejects runtime/path mistakes", () => {
  const manifest = normalizeSessionManifest({
    schemaVersion: "1", runtime: "openclaw", generatedAt: "2026-09-24T00:00:00Z",
    skills: [{ name: "built-in", description: "host reported" }, { name: "local", file: "/tmp/local/SKILL.md" }],
    actualUsedSkillNames: ["built-in"],
    plugins: [{ name: "demo", version: "1.0.0" }]
  }, { runtime: "openclaw" });
  assert.equal(manifest.syntheticSkills[0].name, "built-in");
  assert.deepEqual(manifest.skillFiles, [path.resolve("/tmp/local/SKILL.md")]);
  assert.deepEqual(manifest.actualUsedSkillNames, ["built-in"]);
  assert.throws(() => normalizeSessionManifest({ runtime: "pi", skillFiles: ["relative.md"] }), /absolute path/);
  assert.throws(() => normalizeSessionManifest({ runtime: "bogus", skillFiles: [] }), /unsupported runtime/);
  assert.throws(() => normalizeSessionManifest({ runtime: "pi", skillFiles: [] }, { runtime: "claude" }), /does not match/);
  assert.throws(() => normalizeSessionManifest({ runtime: "pi", skillFiles: [], actualUsedSkillNames: "built-in" }), /actualUsedSkillNames must be an array/);
});

test("loads a manifest from disk and validates malformed JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ownhow-manifest-"));
  try {
    const file = path.join(directory, "manifest.json");
    await writeFile(file, JSON.stringify({ runtime: "skywork", skillFiles: [] }));
    assert.equal((await loadSessionManifest(file, { runtime: "skywork" })).runtime, "skywork");
    await writeFile(file, "{");
    await assert.rejects(loadSessionManifest(file), /Unable to read session manifest/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("summarizes lifecycle states and makes unknown visibility explicit", () => {
  const summary = summarizeLifecycle([
    { kind: "skill", lifecycle: { discovered: true, installed: true, enabled: true, sessionVisible: true } },
    { kind: "skill", lifecycle: { discovered: true, installed: null, enabled: null, sessionVisible: null } },
    { kind: "plugin", lifecycle: { discovered: true, installed: true, enabled: true, sessionVisible: true } }
  ]);
  assert.equal(summary.totalSkills, 2);
  assert.equal(summary.sessionVisible, 1);
  assert.equal(summary.unknownSessionVisibility, 1);
  assert.equal(summary.unknownActualUsed, 2);
  assert.equal(summary.confirmed, false);
  assert.equal(summary.visibility, "unknown");
});
