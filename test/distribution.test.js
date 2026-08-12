import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../src/scanner.js";

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
  assert.match(skill.description, /OwnHow CLI/);
  assert.equal(hermesSkill.name, "ownhow-governance");
  assert.match(hermesSkill.description, /Hermes/);
});
