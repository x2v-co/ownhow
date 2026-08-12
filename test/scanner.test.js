import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defaultRoots, scanRoots } from "../src/scanner.js";
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
