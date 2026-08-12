import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defaultRoots, runtimeRoots, scanRoots } from "../src/scanner.js";
import { analyzeInventory } from "../src/analyzer.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "home");

test("scans plugins and standalone skills without mutating them", async () => {
  const inventory = await scanRoots({ roots: [path.join(fixtures, ".codex", "plugins"), path.join(fixtures, ".agents", "skills")] });
  assert.equal(inventory.components.filter((item) => item.kind === "plugin").length, 1);
  assert.equal(inventory.components.filter((item) => item.kind === "skill").length, 2);
  const bundled = inventory.components.find((item) => item.plugin === "demo-review");
  assert.equal(bundled.name, "reviewer");
  assert.deepEqual(bundled.tools, ["git", "messenger"]);
});

test("finds actionable conflicts and summarizes governance coverage", async () => {
  const inventory = await scanRoots({ roots: [path.join(fixtures, ".codex", "plugins"), path.join(fixtures, ".agents", "skills")] });
  const analysis = analyzeInventory(inventory);
  assert.ok(analysis.findings.some((item) => item.type === "duplicate_name"));
  assert.ok(analysis.findings.some((item) => item.type === "write_collision" || item.type === "duplicate_name"));
  assert.ok(analysis.riskInventory.external_message >= 1);
  assert.equal(analysis.coverage.totalSkills, 2);
});

test("discovers Hermes skills and records their runtime", async () => {
  const hermesRoot = path.join(fixtures, ".hermes", "skills");
  assert.deepEqual(defaultRoots({ home: fixtures, cwd: fixtures, runtime: "hermes" }), [hermesRoot]);

  const inventory = await scanRoots({ roots: [hermesRoot], home: fixtures });
  assert.equal(inventory.components.length, 1);
  assert.equal(inventory.components[0].name, "hermes-research");
  assert.equal(inventory.components[0].runtime, "hermes");
});

test("honors HERMES_HOME for profile-scoped discovery", () => {
  const profile = path.join(fixtures, ".hermes", "profiles", "coder");
  assert.deepEqual(defaultRoots({ home: fixtures, cwd: fixtures, hermesHome: profile, runtime: "hermes" }), [path.join(profile, "skills")]);
});

test("marks project-local Codex skill roots", async () => {
  const project = path.join(fixtures, "project");
  const skillRoot = path.join(fixtures, ".agents", "skills");
  const inventory = await scanRoots({ roots: [skillRoot], cwd: project, home: fixtures });
  assert.equal(inventory.components[0].runtime, "codex");
});

test("matches Hermes active-skill discovery semantics", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-hermes-scan-"));
  const hermesHome = path.join(temporary, ".hermes");
  const skills = path.join(hermesHome, "skills");
  const external = path.join(temporary, "external-skill");
  const skill = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} description\n${extra}---\n\n# ${name}\n`;
  try {
    await Promise.all([
      mkdir(path.join(skills, "active", "references", "nested"), { recursive: true }),
      mkdir(path.join(skills, ".archive", "archived"), { recursive: true }),
      mkdir(path.join(skills, "kanban-only"), { recursive: true }),
      mkdir(path.join(skills, "disabled"), { recursive: true }),
      mkdir(external, { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(skills, "active", "SKILL.md"), skill("active")),
      writeFile(path.join(skills, "active", "references", "nested", "SKILL.md"), skill("nested-support")),
      writeFile(path.join(skills, ".archive", "archived", "SKILL.md"), skill("archived")),
      writeFile(path.join(skills, "kanban-only", "SKILL.md"), skill("kanban-only", "environments:\n  - kanban\n")),
      writeFile(path.join(skills, "disabled", "SKILL.md"), skill("disabled")),
      writeFile(path.join(external, "SKILL.md"), skill("linked")),
      writeFile(path.join(hermesHome, "config.yaml"), "skills:\n  disabled:\n    - disabled\n")
    ]);
    await symlink(external, path.join(skills, "linked"), "dir");

    const inventory = await scanRoots({ roots: [skills], runtime: "hermes", hermesHome });
    assert.deepEqual(inventory.components.map((item) => item.name).sort(), ["active", "linked"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("matches Claude Code active skill and plugin discovery", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-claude-scan-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const personal = path.join(home, ".claude", "skills");
  const plugins = path.join(home, ".claude", "plugins");
  const currentPlugin = path.join(plugins, "cache", "market", "demo", "2.0.0");
  const oldPlugin = path.join(plugins, "cache", "market", "demo", "1.0.0");
  const external = path.join(temporary, "external-linked");
  const skill = (name) => `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`;
  try {
    await Promise.all([
      mkdir(path.join(personal, "personal-wins"), { recursive: true }),
      mkdir(path.join(personal, "disabled"), { recursive: true }),
      mkdir(path.join(project, ".claude", "skills", "personal-wins"), { recursive: true }),
      mkdir(path.join(project, ".claude", "skills", "project-only"), { recursive: true }),
      mkdir(path.join(currentPlugin, ".claude-plugin"), { recursive: true }),
      mkdir(path.join(currentPlugin, "skills", "current"), { recursive: true }),
      mkdir(path.join(oldPlugin, ".claude-plugin"), { recursive: true }),
      mkdir(path.join(oldPlugin, "skills", "old"), { recursive: true }),
      mkdir(external, { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(project, ".git"), "fixture"),
      writeFile(path.join(personal, "personal-wins", "SKILL.md"), skill("personal-wins")),
      writeFile(path.join(personal, "disabled", "SKILL.md"), skill("disabled")),
      writeFile(path.join(project, ".claude", "skills", "personal-wins", "SKILL.md"), skill("personal-wins")),
      writeFile(path.join(project, ".claude", "skills", "project-only", "SKILL.md"), skill("project-only")),
      writeFile(path.join(external, "SKILL.md"), skill("linked")),
      writeFile(path.join(currentPlugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin", version: "2.0.0" })),
      writeFile(path.join(currentPlugin, "skills", "current", "SKILL.md"), skill("current")),
      writeFile(path.join(oldPlugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin", version: "1.0.0" })),
      writeFile(path.join(oldPlugin, "skills", "old", "SKILL.md"), skill("old")),
      writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "demo@market": true }, skillOverrides: { disabled: "off" } })),
      writeFile(path.join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "demo@market": [{ scope: "user", version: "2.0.0", installPath: currentPlugin, lastUpdated: "2026-01-02" }] } }))
    ]);
    await symlink(external, path.join(personal, "linked"), "dir");

    const roots = await runtimeRoots({ runtime: "claude", home, cwd: project });
    assert.ok(roots.includes(currentPlugin));
    assert.ok(!roots.includes(oldPlugin));
    const inventory = await scanRoots({ roots, runtime: "claude", home, cwd: project });
    assert.deepEqual(inventory.components.filter((item) => item.kind === "skill").map((item) => item.name).sort(), ["demo-plugin:current", "linked", "personal-wins", "project-only"]);
    assert.equal(inventory.components.find((item) => item.kind === "plugin").version, "2.0.0");
    assert.equal(inventory.components.find((item) => item.name === "personal-wins").source, path.join(personal, "personal-wins"));
    assert.ok(inventory.components.every((item) => item.runtime === "claude"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
