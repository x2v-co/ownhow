import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { normalizeText, tokenize } from "./text.js";

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1).split(",").map(parseScalar).filter(Boolean);
  return trimmed;
}

export function parseFrontmatter(text) {
  const match = text.match(FRONTMATTER);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split("\n")) {
    const item = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (item) result[item[1]] = parseScalar(item[2]);
  }
  return result;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function walk(directory, predicate, results = []) {
  if (!(await exists(directory))) return results;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "node_modules", ".ownhow"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file, predicate, results);
    else if (predicate(file)) results.push(file);
  }
  return results;
}

function digest(text) { return createHash("sha256").update(text).digest("hex").slice(0, 16); }
function componentId(kind, root, sourceRoot) { return `${kind}:${digest(sourceRoot).slice(0, 8)}:${path.relative(sourceRoot, root).replaceAll(path.sep, "/") || path.basename(root)}`; }
function normalizedList(value) { return Array.isArray(value) ? value.map(String) : value == null || value === "" ? [] : [String(value)]; }

async function readSkill(skillFile, plugin, sourceRoot) {
  const body = await readFile(skillFile, "utf8");
  const metadata = parseFrontmatter(body);
  const directory = path.dirname(skillFile);
  const name = String(metadata.name ?? path.basename(directory));
  const description = String(metadata.description ?? "");
  const text = normalizeText(`${name} ${description} ${body.replace(FRONTMATTER, "")}`);
  return {
    id: componentId("skill", directory, sourceRoot), kind: "skill", name,
    version: String(metadata.version ?? plugin?.version ?? "unversioned"), description,
    source: directory, plugin: plugin?.name ?? null, pluginVersion: plugin?.version ?? null,
    metadata, triggers: normalizedList(metadata.triggers ?? metadata.when), excludes: normalizedList(metadata.excludes ?? metadata.avoid),
    reads: normalizedList(metadata.reads), writes: normalizedList(metadata.writes), tools: normalizedList(metadata.tools),
    sideEffects: normalizedList(metadata.side_effects ?? metadata.sideEffects), text, tokens: [...tokenize(text)], digest: digest(body)
  };
}

async function readPlugin(manifestFile, sourceRoot) {
  const root = path.dirname(path.dirname(manifestFile));
  const raw = await readFile(manifestFile, "utf8");
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return []; }
  const skillsDirectory = path.resolve(root, String(manifest.skills ?? "./skills"));
  const skillFiles = await walk(skillsDirectory, (file) => path.basename(file) === "SKILL.md");
  const plugin = {
    id: componentId("plugin", root, sourceRoot), kind: "plugin", name: String(manifest.name ?? path.basename(root)),
    version: String(manifest.version ?? "unversioned"), description: String(manifest.description ?? manifest.interface?.shortDescription ?? ""),
    source: root, manifest: manifestFile, metadata: manifest, skills: skillFiles.length,
    mcpServers: manifest.mcpServers ? path.resolve(root, String(manifest.mcpServers)) : null,
    apps: manifest.apps ? path.resolve(root, String(manifest.apps)) : null,
    hooks: manifest.hooks ?? ((await exists(path.join(root, "hooks", "hooks.json"))) ? path.join(root, "hooks", "hooks.json") : null),
    digest: digest(raw), tokens: [...tokenize(`${manifest.name ?? ""} ${manifest.description ?? ""} ${manifest.interface?.shortDescription ?? ""}`)]
  };
  return [plugin, ...(await Promise.all(skillFiles.map((file) => readSkill(file, plugin, sourceRoot))))];
}

export function defaultRoots({ cwd = process.cwd(), home = os.homedir() } = {}) {
  return [path.join(home, ".codex", "plugins"), path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills"), path.join(cwd, ".agents", "plugins"), path.join(cwd, "plugins"), path.join(cwd, "skills")];
}

export async function scanRoots({ roots = defaultRoots(), cwd = process.cwd() } = {}) {
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const components = [];
  const seen = new Set();
  for (const sourceRoot of uniqueRoots) {
    const manifests = await walk(sourceRoot, (file) => path.basename(file) === "plugin.json" && path.basename(path.dirname(file)) === ".codex-plugin");
    for (const manifest of manifests) {
      for (const entry of await readPlugin(manifest, sourceRoot)) if (!seen.has(entry.id)) { seen.add(entry.id); components.push(entry); }
    }
    for (const skillFile of await walk(sourceRoot, (file) => path.basename(file) === "SKILL.md")) {
      if (components.some((entry) => entry.kind === "skill" && entry.source === path.dirname(skillFile))) continue;
      const skill = await readSkill(skillFile, null, sourceRoot);
      if (!seen.has(skill.id)) { seen.add(skill.id); components.push(skill); }
    }
  }
  return { schemaVersion: "0.1", generatedAt: new Date().toISOString(), cwd: path.resolve(cwd), roots: uniqueRoots, components: components.sort((a, b) => a.id.localeCompare(b.id)) };
}
