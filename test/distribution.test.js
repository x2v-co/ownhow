import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../src/scanner.js";
import { REQUIRED_CHECKS } from "../src/audit-checks.js";
import { loadTelemetryConfig } from "../src/telemetry.js";

const exec = promisify(execFile);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));

test("keeps the CLI, Plugin, marketplace, and Skill release metadata aligned", async () => {
  const packageMetadata = await readJson("package.json");
  const plugin = await readJson("plugins/ownhow/.codex-plugin/plugin.json");
  const claudePlugin = await readJson("plugins/ownhow/.claude-plugin/plugin.json");
  const marketplace = await readJson(".agents/plugins/marketplace.json");
  const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");
  const skillText = await readFile(path.join(root, "plugins/ownhow/skills/govern-personal-methods/SKILL.md"), "utf8");
  const skill = parseFrontmatter(skillText);
  const hermesSkillText = await readFile(path.join(root, "skills/ownhow-governance/SKILL.md"), "utf8");
  const hermesSkill = parseFrontmatter(hermesSkillText);

  assert.equal(plugin.name, "ownhow");
  assert.equal(plugin.version, packageMetadata.version);
  assert.equal(plugin.license, packageMetadata.license);
  assert.equal(claudePlugin.name, plugin.name);
  assert.equal(claudePlugin.version, packageMetadata.version);
  assert.equal(claudePlugin.license, packageMetadata.license);
  assert.equal(marketplace.name, "x2v");
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source.path, "./plugins/ownhow");
  assert.equal(claudeMarketplace.name, marketplace.name);
  assert.equal(claudeMarketplace.plugins[0].name, plugin.name);
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/ownhow");
  assert.equal(claudeMarketplace.plugins[0].version, packageMetadata.version);
  assert.equal(skill.name, "govern-personal-methods");
  assert.equal(skill.version, packageMetadata.version);
  assert.equal(hermesSkill.version, packageMetadata.version);
  assert.match(skill.description, /OwnHow CLI/);
  assert.equal(hermesSkill.name, "ownhow-governance");
  assert.deepEqual(skill.required_checks, REQUIRED_CHECKS.map((check) => check.id));
  assert.deepEqual(hermesSkill.required_checks, skill.required_checks);
  assert.match(hermesSkill.description, /Hermes/);
  assert.deepEqual(packageMetadata.pi.skills, ["./skills/ownhow-governance"]);
  assert.match(hermesSkill.description, /Pi/);
  assert.match(hermesSkill.description, /OpenCode/);
  assert.match(hermesSkill.description, /OpenClaw/);
  assert.match(skillText, /ownhow upgrade --auto --json/);
  assert.match(skillText, /approval_required/);
  assert.match(hermesSkillText, /ownhow upgrade --auto --json/);
  assert.equal(packageMetadata.private, undefined);
  assert.equal(packageMetadata.bin.ownhow, "src/cli.js");
  assert.ok(packageMetadata.files.includes("src/"));
  assert.ok(packageMetadata.files.includes("docs/"));
});

test("the published tarball includes the CLI and opt-in telemetry", async () => {
  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], { cwd: root });
  const packed = JSON.parse(stdout);
  const paths = new Set(packed[0].files.map((file) => file.path));
  for (const file of ["src/cli.js", "src/telemetry.js", "docs/telemetry.md", "package.json"]) {
    assert.ok(paths.has(file), file);
  }
  assert.equal((await loadTelemetryConfig(path.join(root, "does-not-exist"))).mode, "off");
});
