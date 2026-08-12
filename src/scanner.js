import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { normalizeText, tokenize } from "./text.js";
import { claudeRuntime } from "./runtimes/claude.js";

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const COMMON_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".ownhow"]);
const HERMES_EXCLUDED_DIRECTORIES = new Set([".git", ".github", ".hub", ".archive", ".venv", "venv", "node_modules", "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache"]);
const CLAUDE_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".ownhow"]);
const SKILL_SUPPORT_DIRECTORIES = new Set(["references", "templates", "assets", "scripts"]);

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
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const item = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!item) continue;
    const value = parseScalar(item[2]);
    if (value !== "") { result[item[1]] = value; continue; }
    const sequence = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1].match(/^\s+-\s*(.+)$/);
      if (!next) break;
      sequence.push(parseScalar(next[1]));
      index += 1;
    }
    result[item[1]] = sequence.length ? sequence : "";
  }
  return result;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function walk(directory, predicate, results = [], options = {}, visited = new Set()) {
  if (!(await exists(directory))) return results;
  let canonical;
  try { canonical = await realpath(directory); } catch { return results; }
  if (visited.has(canonical)) return results;
  visited.add(canonical);
  const entries = await readdir(directory, { withFileTypes: true });
  const hasSkill = entries.some((entry) => entry.name === "SKILL.md" && !entry.isDirectory());
  const excluded = options.excludedDirectories ?? COMMON_EXCLUDED_DIRECTORIES;
  for (const entry of entries) {
    if (excluded.has(entry.name) || (options.pruneSkillSupport && hasSkill && SKILL_SUPPORT_DIRECTORIES.has(entry.name))) continue;
    const file = path.join(directory, entry.name);
    let directoryEntry = entry.isDirectory();
    if (entry.isSymbolicLink() && options.followSymlinks) {
      try { directoryEntry = (await stat(file)).isDirectory(); } catch { continue; }
    }
    if (directoryEntry) await walk(file, predicate, results, options, visited);
    else if (predicate(file)) results.push(file);
  }
  return results;
}

function digest(text) { return createHash("sha256").update(text).digest("hex").slice(0, 16); }
function componentId(kind, root, sourceRoot) { return `${kind}:${digest(sourceRoot).slice(0, 8)}:${path.relative(sourceRoot, root).replaceAll(path.sep, "/") || path.basename(root)}`; }
function normalizedList(value) { return Array.isArray(value) ? value.map(String) : value == null || value === "" ? [] : [String(value)]; }

function matchesPlatform(metadata) {
  const platforms = normalizedList(metadata.platforms);
  if (!platforms.length) return true;
  const aliases = { macos: "darwin", windows: "win32" };
  return platforms.some((value) => process.platform.startsWith(aliases[value.toLowerCase()] ?? value.toLowerCase()));
}

async function matchesEnvironment(metadata) {
  const environments = normalizedList(metadata.environments).map((value) => value.toLowerCase());
  if (!environments.length) return true;
  for (const environment of environments) {
    if (!["kanban", "docker", "s6"].includes(environment)) return true;
    if (environment === "kanban" && (process.env.HERMES_KANBAN_TASK || process.env.HERMES_KANBAN_BOARD)) return true;
    if (environment === "docker" && ((await exists("/.dockerenv")) || (await exists("/run/.containerenv")))) return true;
    if (environment === "s6" && ((await exists("/run/s6")) || (await exists("/package/admin/s6-overlay")))) return true;
  }
  return false;
}

async function readHermesDisabled(hermesHome) {
  let text;
  try { text = await readFile(path.join(hermesHome, "config.yaml"), "utf8"); } catch { return new Set(); }
  const allLines = text.split("\n");
  const start = allLines.findIndex((line) => /^skills:\s*$/.test(line));
  if (start < 0) return new Set();
  const lines = [];
  for (let index = start + 1; index < allLines.length; index += 1) {
    if (/^\S/.test(allLines[index])) break;
    lines.push(allLines[index]);
  }
  const disabled = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index].match(/^\s{2}disabled:\s*(.*)$/);
    if (!item) continue;
    const inline = normalizedList(parseScalar(item[1]));
    for (const name of inline) disabled.add(name);
    while (index + 1 < lines.length) {
      const next = lines[index + 1].match(/^\s{4}-\s*(.+)$/);
      if (!next) break;
      disabled.add(String(parseScalar(next[1])));
      index += 1;
    }
  }
  return disabled;
}

function runtimeFor(sourceRoot, { cwd = process.cwd(), home = os.homedir(), hermesHome = process.env.HERMES_HOME } = {}) {
  const source = path.resolve(sourceRoot);
  const hermes = path.resolve(hermesHome || path.join(home, ".hermes"), "skills");
  const claude = path.resolve(home, ".claude");
  const codex = [path.resolve(home, ".codex"), path.resolve(home, ".agents"), path.resolve(cwd, ".agents"), path.resolve(cwd, "plugins"), path.resolve(cwd, "skills")];
  if (source === hermes || source.startsWith(`${hermes}${path.sep}`)) return "hermes";
  if (source === claude || source.startsWith(`${claude}${path.sep}`) || source.includes(`${path.sep}.claude${path.sep}skills`)) return "claude";
  if (codex.some((root) => source === root || source.startsWith(`${root}${path.sep}`))) return "codex";
  return "unknown";
}

async function readSkill(skillFile, plugin, sourceRoot, runtime) {
  const body = await readFile(skillFile, "utf8");
  const metadata = parseFrontmatter(body);
  const directory = path.dirname(skillFile);
  const skillName = String(metadata.name ?? path.basename(directory));
  const name = runtime === "claude" && plugin ? `${plugin.name}:${skillName}` : skillName;
  const description = String(metadata.description ?? "");
  const text = normalizeText(`${name} ${description} ${body.replace(FRONTMATTER, "")}`);
  return {
    id: componentId("skill", directory, sourceRoot), kind: "skill", runtime, name, skillName,
    version: String(metadata.version ?? plugin?.version ?? "unversioned"), description,
    source: directory, plugin: plugin?.name ?? null, pluginVersion: plugin?.version ?? null,
    metadata, triggers: normalizedList(metadata.triggers ?? metadata.when), excludes: normalizedList(metadata.excludes ?? metadata.avoid),
    reads: normalizedList(metadata.reads), writes: normalizedList(metadata.writes), tools: normalizedList(metadata.tools),
    sideEffects: normalizedList(metadata.side_effects ?? metadata.sideEffects), text, tokens: [...tokenize(text)], digest: digest(body)
  };
}

function skillDirectories(root, manifest, runtime) {
  if (runtime !== "claude") return [path.resolve(root, String(manifest.skills ?? "./skills"))];
  const custom = normalizedList(manifest.skills).map((value) => path.resolve(root, value));
  return [...new Set([path.join(root, "skills"), ...custom])];
}

async function readPlugin(manifestFile, sourceRoot, runtime) {
  const root = path.dirname(path.dirname(manifestFile));
  const raw = await readFile(manifestFile, "utf8");
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return []; }
  const directories = skillDirectories(root, manifest, runtime);
  const skillFiles = [];
  for (const directory of directories) await walk(directory, (file) => path.basename(file) === "SKILL.md", skillFiles, runtime === "claude" ? { followSymlinks: true, pruneSkillSupport: true } : {});
  if (runtime === "claude" && !skillFiles.length && !manifest.skills && await exists(path.join(root, "SKILL.md"))) skillFiles.push(path.join(root, "SKILL.md"));
  const plugin = {
    id: componentId("plugin", root, sourceRoot), kind: "plugin", runtime, name: String(manifest.name ?? path.basename(root)),
    version: String(manifest.version ?? "unversioned"), description: String(manifest.description ?? manifest.interface?.shortDescription ?? ""),
    source: root, manifest: manifestFile, metadata: manifest, skills: skillFiles.length,
    mcpServers: manifest.mcpServers ? path.resolve(root, String(manifest.mcpServers)) : null,
    apps: manifest.apps ? path.resolve(root, String(manifest.apps)) : null,
    hooks: manifest.hooks ?? ((await exists(path.join(root, "hooks", "hooks.json"))) ? path.join(root, "hooks", "hooks.json") : null),
    digest: digest(raw), tokens: [...tokenize(`${manifest.name ?? ""} ${manifest.description ?? ""} ${manifest.interface?.shortDescription ?? ""}`)]
  };
  return [plugin, ...(await Promise.all(skillFiles.map((file) => readSkill(file, plugin, sourceRoot, runtime))))];
}

export function defaultRoots({ cwd = process.cwd(), home = os.homedir(), hermesHome = process.env.HERMES_HOME, runtime = "all" } = {}) {
  const codex = [path.join(home, ".codex", "plugins"), path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills"), path.join(cwd, ".agents", "plugins"), path.join(cwd, "plugins"), path.join(cwd, "skills")];
  const hermes = [path.join(hermesHome || path.join(home, ".hermes"), "skills")];
  const claude = [path.join(home, ".claude", "skills"), path.join(cwd, ".claude", "skills")];
  if (runtime === "codex") return codex;
  if (runtime === "hermes") return hermes;
  if (runtime === "claude") return claude;
  return [...codex, ...hermes, ...claude];
}

export async function runtimeRoots({ cwd = process.cwd(), home = os.homedir(), hermesHome = process.env.HERMES_HOME, runtime = "all" } = {}) {
  if (runtime === "claude") return (await claudeRuntime({ cwd, home })).roots;
  if (runtime === "all") return [...defaultRoots({ cwd, home, hermesHome, runtime: "codex" }), ...defaultRoots({ cwd, home, hermesHome, runtime: "hermes" }), ...(await claudeRuntime({ cwd, home })).roots];
  return defaultRoots({ cwd, home, hermesHome, runtime });
}

export async function scanRoots({ roots = defaultRoots(), cwd = process.cwd(), runtime = "auto", home = os.homedir(), hermesHome = process.env.HERMES_HOME } = {}) {
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const components = [];
  const seen = new Set();
  const seenHermesNames = new Set();
  const seenClaudeNames = new Set();
  const seenClaudeTargets = new Set();
  const claude = await claudeRuntime({ cwd, home });
  for (const sourceRoot of uniqueRoots) {
    const sourceRuntime = runtime === "auto" ? runtimeFor(sourceRoot, { cwd, home, hermesHome }) : runtime;
    const resolvedHermesHome = hermesHome || (sourceRuntime === "hermes" ? path.dirname(sourceRoot) : path.join(home, ".hermes"));
    const disabledHermesSkills = sourceRuntime === "hermes" ? await readHermesDisabled(resolvedHermesHome) : new Set();
    const claudeExcluded = claude.pluginRoots.has(sourceRoot) ? COMMON_EXCLUDED_DIRECTORIES : CLAUDE_EXCLUDED_DIRECTORIES;
    const walkOptions = sourceRuntime === "hermes" ? { excludedDirectories: HERMES_EXCLUDED_DIRECTORIES, followSymlinks: true, pruneSkillSupport: true } : sourceRuntime === "claude" ? { excludedDirectories: claudeExcluded, followSymlinks: true, pruneSkillSupport: true } : {};
    const manifestDirectory = sourceRuntime === "claude" ? ".claude-plugin" : ".codex-plugin";
    const manifests = await walk(sourceRoot, (file) => path.basename(file) === "plugin.json" && path.basename(path.dirname(file)) === manifestDirectory, [], walkOptions);
    for (const manifest of manifests) {
      if (sourceRuntime === "claude" && claude.skillRoots.has(sourceRoot)) {
        let metadata;
        try { metadata = JSON.parse(await readFile(manifest, "utf8")); } catch { continue; }
        if (claude.disabledPlugins.has(`${metadata.name}@skills-dir`)) continue;
      }
      for (const entry of await readPlugin(manifest, sourceRoot, sourceRuntime)) if (!seen.has(entry.id)) { seen.add(entry.id); components.push(entry); }
    }
    for (const skillFile of await walk(sourceRoot, (file) => path.basename(file) === "SKILL.md", [], walkOptions)) {
      if (components.some((entry) => entry.kind === "skill" && entry.source === path.dirname(skillFile))) continue;
      const skill = await readSkill(skillFile, null, sourceRoot, sourceRuntime);
      if (sourceRuntime === "hermes" && (!matchesPlatform(skill.metadata) || !(await matchesEnvironment(skill.metadata)) || disabledHermesSkills.has(skill.name) || seenHermesNames.has(skill.name))) continue;
      if (sourceRuntime === "hermes") seenHermesNames.add(skill.name);
      if (sourceRuntime === "claude") {
        let target;
        try { target = await realpath(path.dirname(skillFile)); } catch { continue; }
        if (claude.disabledSkills.has(skill.name) || seenClaudeNames.has(skill.name) || seenClaudeTargets.has(target)) continue;
        seenClaudeNames.add(skill.name);
        seenClaudeTargets.add(target);
      }
      if (!seen.has(skill.id)) { seen.add(skill.id); components.push(skill); }
    }
  }
  return { schemaVersion: "0.1", generatedAt: new Date().toISOString(), cwd: path.resolve(cwd), roots: uniqueRoots, components: components.sort((a, b) => a.id.localeCompare(b.id)) };
}
