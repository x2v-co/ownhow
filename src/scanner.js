import { parseDocument } from "./vendor/yaml.js";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { normalizeText, tokenize } from "./text.js";
import { claudeRuntime } from "./runtimes/claude.js";
import { piRuntime } from "./runtimes/pi.js";
import { opencodeRuntime } from "./runtimes/opencode.js";
import { openclawRuntime } from "./runtimes/openclaw.js";
import { auditSkill } from "./audit-checks.js";

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const TEMPORARY_OR_BUILD_DIRECTORIES = new Set([".ownhow-disabled", ".review", ".smoke", ".worktree", ".worktrees", "worktree", "worktrees", "build", "dist", "out", "target", "coverage", ".next", ".turbo", ".tmp", "tmp"]);
const COMMON_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".ownhow", ...TEMPORARY_OR_BUILD_DIRECTORIES]);
const HERMES_EXCLUDED_DIRECTORIES = new Set([".git", ".github", ".hub", ".archive", ".venv", "venv", "node_modules", "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ...TEMPORARY_OR_BUILD_DIRECTORIES]);
const CLAUDE_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".ownhow", ...TEMPORARY_OR_BUILD_DIRECTORIES]);
const AGENT_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".ownhow", ...TEMPORARY_OR_BUILD_DIRECTORIES]);
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
  if (Buffer.byteLength(match[1]) > 128 * 1024) throw new Error("Skill metadata exceeds 128 KiB");
  const document = parseDocument(match[1], { schema: "core", uniqueKeys: true, customTags: [] });
  if (document.errors.length || document.warnings.length) {
    throw new Error(`Invalid Skill metadata: ${[...document.errors, ...document.warnings].map((item) => item.message).join("; ")}`);
  }
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill metadata must be a mapping");
  return value;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function walk(directory, predicate, results = [], options = {}, visited = new Set()) {
  let canonical;
  try { canonical = await realpath(directory); } catch { return results; }
  if (visited.has(canonical)) return results;
  visited.add(canonical);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return results; }
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

// A scanRuntime("all") run can expose the same roots through several host
// adapters (for example ~/.agents/skills). Keep the expensive directory walk
// and file reads shared for the lifetime of that scan. The cache is deliberately
// internal so the public scanner API remains unchanged.
function createScanCache() {
  return { canonical: new Map(), walks: new Map(), files: new Map(), audits: new Map() };
}

async function canonicalPath(file, cache) {
  const resolved = path.resolve(file);
  if (!cache) return realpath(resolved).catch(() => resolved);
  if (cache.canonical.has(resolved)) return cache.canonical.get(resolved);
  const pending = realpath(resolved).catch(() => resolved);
  cache.canonical.set(resolved, pending);
  const canonical = await pending;
  cache.canonical.set(resolved, canonical);
  if (!cache.canonical.has(canonical)) cache.canonical.set(canonical, canonical);
  return canonical;
}

function walkOptionsKey(options = {}) {
  const excluded = [...(options.excludedDirectories ?? COMMON_EXCLUDED_DIRECTORIES)].sort().join(",");
  return `${options.followSymlinks ? 1 : 0}:${options.pruneSkillSupport ? 1 : 0}:${excluded}`;
}

async function cachedWalk(directory, predicate, kind, options = {}, cache = null) {
  if (!cache) return walk(directory, predicate, [], options);
  const canonical = await canonicalPath(directory, cache);
  const key = `${canonical}\0${kind}\0${walkOptionsKey(options)}`;
  if (cache.walks.has(key)) return [...cache.walks.get(key)];
  // Preserve the caller's path spelling in component sources while using the
  // canonical path only as the cache key. Subsequent aliases reuse this result.
  const result = await walk(directory, predicate, [], options);
  cache.walks.set(key, [...result]);
  return result;
}

async function cachedReadFile(file, cache) {
  if (!cache) return readFile(file, "utf8");
  const key = path.resolve(file);
  if (cache.files.has(key)) return cache.files.get(key);
  const pending = readFile(file, "utf8");
  cache.files.set(key, pending);
  try {
    const text = await pending;
    cache.files.set(key, text);
    return text;
  } catch (error) {
    cache.files.delete(key);
    throw error;
  }
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
  if (source.startsWith(`${path.resolve(home, ".skywork")}${path.sep}`) || source.startsWith(`${path.resolve(cwd, ".skywork")}${path.sep}`)) return "skywork";
  const codex = [path.resolve(home, ".codex"), path.resolve(home, ".agents"), path.resolve(cwd, ".agents"), path.resolve(cwd, "plugins"), path.resolve(cwd, "skills")];
  if (source === hermes || source.startsWith(`${hermes}${path.sep}`)) return "hermes";
  if (source === claude || source.startsWith(`${claude}${path.sep}`) || source.includes(`${path.sep}.claude${path.sep}skills`)) return "claude";
  if (codex.some((root) => source === root || source.startsWith(`${root}${path.sep}`))) return "codex";
  return "unknown";
}

async function readSkill(skillFile, plugin, sourceRoot, runtime, scanCache = null) {
  const body = await cachedReadFile(skillFile, scanCache);
  let metadata = {};
  let metadataError = null;
  try { metadata = parseFrontmatter(body); } catch (error) { metadataError = error.message; }
  const directory = path.dirname(skillFile);
  const skillName = String(metadata.name ?? path.basename(directory));
  const name = runtime === "claude" && plugin ? `${plugin.name}:${skillName}` : skillName;
  const description = String(metadata.description ?? "");
  const text = normalizeText(`${name} ${description} ${body.replace(FRONTMATTER, "")}`);
  return {
    id: componentId("skill", directory, sourceRoot), kind: "skill", runtime, name, skillName,
    version: String(metadata.version ?? plugin?.version ?? "unversioned"), description,
    source: directory, pluginRoot: plugin?.source ?? null, plugin: plugin?.name ?? null, pluginVersion: plugin?.version ?? null,
    lifecycle: lifecycle(),
    metadata, metadataError, triggers: normalizedList(metadata.triggers ?? metadata.when), excludes: normalizedList(metadata.excludes ?? metadata.avoid),
    reads: normalizedList(metadata.reads), writes: normalizedList(metadata.writes), tools: normalizedList(metadata.tools),
    sideEffects: normalizedList(metadata.side_effects ?? metadata.sideEffects), text, tokens: [...tokenize(text)], digest: digest(body)
  };
}

function lifecycle({ installed = null, enabled = null, sessionVisible = null, actualUsed = null } = {}) {
  return { discovered: true, installed, enabled, sessionVisible, actualUsed };
}

function syntheticSkill(entry, runtime, state = {}) {
  const name = String(entry.name);
  const description = String(entry.description ?? "");
  const source = String(entry.source ?? `${runtime}:runtime`);
  const metadata = entry.metadata ?? {};
  const text = normalizeText(`${name} ${description}`);
  return {
    id: `${runtime}:skill:${digest(source).slice(0, 8)}:${name}`, kind: "skill", runtime, name, skillName: name,
    version: String(entry.version ?? "unversioned"), description, source, plugin: entry.plugin ?? null, pluginVersion: entry.pluginVersion ?? null,
    metadata, lifecycle: lifecycle(state), triggers: normalizedList(metadata.triggers ?? metadata.when), excludes: normalizedList(metadata.excludes ?? metadata.avoid),
    reads: normalizedList(metadata.reads), writes: normalizedList(metadata.writes), tools: normalizedList(metadata.tools),
    sideEffects: normalizedList(metadata.side_effects ?? metadata.sideEffects), text, tokens: [...tokenize(text)], digest: digest(JSON.stringify(entry))
  };
}

function syntheticPlugin(entry, runtime, state = {}) {
  const name = String(entry.name);
  const source = String(entry.source ?? `${runtime}:plugin:${name}`);
  return {
    id: `${runtime}:plugin:${digest(source).slice(0, 8)}:${name}`, kind: "plugin", runtime, name,
    version: String(entry.version ?? "unversioned"), description: String(entry.description ?? ""), source,
    manifest: null, metadata: entry.metadata ?? {}, lifecycle: lifecycle(state), skills: entry.skills ?? null, mcpServers: null, apps: null, hooks: null,
    digest: digest(JSON.stringify(entry)), tokens: [...tokenize(`${name} ${entry.description ?? ""}`)]
  };
}

function skillDirectories(root, manifest, runtime) {
  if (runtime !== "claude") return [path.resolve(root, String(manifest.skills ?? "./skills"))];
  const custom = normalizedList(manifest.skills).map((value) => path.resolve(root, value));
  return [...new Set([path.join(root, "skills"), ...custom])];
}

async function readPlugin(manifestFile, sourceRoot, runtime, scanCache = null) {
  const root = path.dirname(path.dirname(manifestFile));
  const raw = await cachedReadFile(manifestFile, scanCache);
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return []; }
  const directories = skillDirectories(root, manifest, runtime);
  const skillFiles = [];
  const walkOptions = runtime === "claude" ? { followSymlinks: true, pruneSkillSupport: true } : {};
  for (const directory of directories) skillFiles.push(...await cachedWalk(directory, (file) => path.basename(file) === "SKILL.md", "skill", walkOptions, scanCache));
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
  return [plugin, ...(await Promise.all(skillFiles.map((file) => readSkill(file, plugin, sourceRoot, runtime, scanCache))))];
}

export function defaultRoots({ cwd = process.cwd(), home = os.homedir(), hermesHome = process.env.HERMES_HOME, runtime = "all" } = {}) {
  const codex = [path.join(home, ".codex", "plugins"), path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills"), path.join(cwd, ".agents", "plugins"), path.join(cwd, "plugins"), path.join(cwd, "skills")];
  const hermes = [path.join(hermesHome || path.join(home, ".hermes"), "skills")];
  const claude = [path.join(home, ".claude", "skills"), path.join(cwd, ".claude", "skills")];
  const pi = [path.join(home, ".pi", "agent", "skills"), path.join(home, ".agents", "skills"), path.join(cwd, ".pi", "skills"), path.join(cwd, ".agents", "skills")];
  const opencode = [path.join(home, ".config", "opencode"), path.join(home, ".agents", "skills"), path.join(home, ".claude", "skills"), path.join(cwd, ".opencode"), path.join(cwd, ".agents", "skills"), path.join(cwd, ".claude", "skills")];
  const openclaw = [path.join(home, ".openclaw", "workspace", "skills"), path.join(home, ".openclaw", "workspace", ".agents", "skills"), path.join(home, ".agents", "skills"), path.join(home, ".openclaw", "skills")];
  const skywork = [path.join(home, ".skywork", "plugins"), path.join(home, ".skywork", "skills"), path.join(cwd, ".skywork", "skills")];
  if (runtime === "skywork") return skywork;
  if (runtime === "codex") return codex;
  if (runtime === "hermes") return hermes;
  if (runtime === "claude") return claude;
  if (runtime === "pi") return pi;
  if (runtime === "opencode") return opencode;
  if (runtime === "openclaw") return openclaw;
  return [...codex, ...hermes, ...claude, ...pi, ...opencode, ...openclaw, ...skywork];
}

export async function runtimeRoots({ cwd = process.cwd(), home = os.homedir(), hermesHome = process.env.HERMES_HOME, runtime = "all" } = {}) {
  if (runtime === "claude") return (await claudeRuntime({ cwd, home })).roots;
  if (runtime === "pi") return (await piRuntime({ cwd, home })).roots;
  if (runtime === "opencode") return (await opencodeRuntime({ cwd, home })).roots;
  if (runtime === "openclaw") return (await openclawRuntime({ cwd, home })).roots;
  if (runtime === "all") return [...new Set((await Promise.all(["codex", "hermes", "claude", "pi", "opencode", "openclaw", "skywork"].map((name) => runtimeRoots({ cwd, home, hermesHome, runtime: name })))).flat())];
  return defaultRoots({ cwd, home, hermesHome, runtime });
}

export async function scanRoots({ roots = defaultRoots(), cwd = process.cwd(), runtime = "auto", home = os.homedir(), hermesHome = process.env.HERMES_HOME, runtimeState = null, scanCache: providedScanCache = null } = {}) {
  const scanCache = providedScanCache ?? createScanCache();
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const rootRecords = [];
  const seenCanonicalRoots = new Set();
  for (const root of uniqueRoots) {
    const canonical = await canonicalPath(root, scanCache);
    if (seenCanonicalRoots.has(canonical)) continue;
    seenCanonicalRoots.add(canonical);
    rootRecords.push({ root, canonical });
  }
  const components = [];
  const seen = new Set();
  const seenSkillSources = new Set();
  const seenHermesNames = new Set();
  const seenClaudeNames = new Set();
  const seenClaudeTargets = new Set();
  // Only load Claude's host settings when this projection can actually use
  // them. The previous unconditional adapter call made every runtime scan
  // reread Claude configuration and project ancestry.
  const needsClaude = runtime === "claude" || runtime === "auto" && rootRecords.some(({ root }) => runtimeFor(root, { cwd, home, hermesHome }) === "claude");
  const claude = needsClaude ? await claudeRuntime({ cwd, home }) : { pluginRoots: new Set(), skillRoots: new Set(), disabledSkills: new Set(), disabledPlugins: new Set() };
  const activeSkillNames = runtimeState?.activeSkillNames instanceof Set
    ? runtimeState.activeSkillNames
    : Array.isArray(runtimeState?.activeSkillNames) ? new Set(runtimeState.activeSkillNames.map(String)) : null;
  // actualUsedSkillNames is an optional exhaustive host report. When absent,
  // actual use remains unknown even if the Skill is visible in the session.
  const actualUsedSkillNames = runtimeState?.actualUsedSkillNames instanceof Set
    ? runtimeState.actualUsedSkillNames
    : Array.isArray(runtimeState?.actualUsedSkillNames) ? new Set(runtimeState.actualUsedSkillNames.map(String)) : null;
  const explicitSkillFiles = runtimeState?.authoritative && Array.isArray(runtimeState.skillFiles) ? runtimeState.skillFiles : null;
  const syntheticSkillEntries = runtimeState?.authoritative && Array.isArray(runtimeState.syntheticSkills) ? runtimeState.syntheticSkills : null;
  // A host that supplies synthetic active skills is authoritative about the
  // session. Recursing through its roots would re-introduce inactive and
  // duplicate files, defeating the host's eligibility report.
  const skipRootDiscovery = explicitSkillFiles !== null || syntheticSkillEntries !== null;
  const seenRuntimeNames = new Set();

  const authoritative = runtimeState?.authoritative === true;
  for (const entry of runtimeState?.plugins ?? []) components.push(syntheticPlugin(entry, runtime, { installed: true, enabled: true, sessionVisible: true }));
  if (explicitSkillFiles) {
    for (const skillFile of explicitSkillFiles) {
      const sourceRoot = uniqueRoots.find((root) => skillFile === root || skillFile.startsWith(`${root}${path.sep}`)) ?? path.dirname(skillFile);
      const skill = await readSkill(skillFile, null, sourceRoot, runtime, scanCache);
      skill.lifecycle = lifecycle({ installed: true, enabled: true, sessionVisible: true, actualUsed: actualUsedSkillNames ? actualUsedSkillNames.has(skill.name) : null });
      if (seenRuntimeNames.has(skill.name)) continue;
      seenRuntimeNames.add(skill.name);
      skill.id = `${runtime}:${skill.id}`;
      components.push(skill);
    }
  }
  for (const { root: sourceRoot, canonical: scanDirectory } of rootRecords) {
    if (skipRootDiscovery) break;
    const sourceRuntime = runtime === "auto" ? runtimeFor(sourceRoot, { cwd, home, hermesHome }) : runtime;
    const resolvedHermesHome = hermesHome || (sourceRuntime === "hermes" ? path.dirname(sourceRoot) : path.join(home, ".hermes"));
    const disabledHermesSkills = sourceRuntime === "hermes" ? await readHermesDisabled(resolvedHermesHome) : new Set();
    const claudeExcluded = claude.pluginRoots.has(sourceRoot) ? COMMON_EXCLUDED_DIRECTORIES : CLAUDE_EXCLUDED_DIRECTORIES;
    const walkOptions = sourceRuntime === "hermes" ? { excludedDirectories: HERMES_EXCLUDED_DIRECTORIES, followSymlinks: true, pruneSkillSupport: true } : sourceRuntime === "claude" ? { excludedDirectories: claudeExcluded, followSymlinks: true, pruneSkillSupport: true } : ["pi", "opencode", "openclaw"].includes(sourceRuntime) ? { excludedDirectories: AGENT_EXCLUDED_DIRECTORIES, followSymlinks: true, pruneSkillSupport: true } : {};
    const manifestDirectory = sourceRuntime === "claude" ? ".claude-plugin" : ".codex-plugin";
    const manifests = await cachedWalk(sourceRoot, (file) => path.basename(file) === "plugin.json" && path.basename(path.dirname(file)) === manifestDirectory, "manifest", walkOptions, scanCache);
    for (const manifest of manifests) {
      if (sourceRuntime === "claude" && (claude.skillRoots.has(sourceRoot) || claude.skillRoots.has(scanDirectory))) {
        let metadata;
        try { metadata = JSON.parse(await cachedReadFile(manifest, scanCache)); } catch { continue; }
        if (claude.disabledPlugins.has(`${metadata.name}@skills-dir`)) continue;
      }
      for (const entry of await readPlugin(manifest, sourceRoot, sourceRuntime, scanCache)) {
        entry.lifecycle = lifecycle({ installed: authoritative ? true : null, enabled: authoritative ? true : null, sessionVisible: authoritative ? true : null, actualUsed: authoritative && entry.kind === "skill" && actualUsedSkillNames ? actualUsedSkillNames.has(entry.name) : null });
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          components.push(entry);
          if (entry.kind === "skill") seenSkillSources.add(path.resolve(entry.source));
        }
      }
    }
    for (const skillFile of await cachedWalk(sourceRoot, (file) => path.basename(file) === "SKILL.md", "skill", walkOptions, scanCache)) {
      const skillSource = path.resolve(path.dirname(skillFile));
      if (seenSkillSources.has(skillSource)) continue;
      const skill = await readSkill(skillFile, null, sourceRoot, sourceRuntime, scanCache);
      if (sourceRuntime === "hermes" && (!matchesPlatform(skill.metadata) || !(await matchesEnvironment(skill.metadata)) || disabledHermesSkills.has(skill.name) || seenHermesNames.has(skill.name))) continue;
      if (sourceRuntime === "hermes") seenHermesNames.add(skill.name);
      if (sourceRuntime === "claude") {
        let target;
        try { target = await realpath(path.dirname(skillFile)); } catch { continue; }
        if (claude.disabledSkills.has(skill.name) || seenClaudeNames.has(skill.name) || seenClaudeTargets.has(target)) continue;
        seenClaudeNames.add(skill.name);
        seenClaudeTargets.add(target);
      }
      if (["pi", "opencode", "openclaw"].includes(sourceRuntime)) {
        if ((activeSkillNames && !activeSkillNames.has(skill.name)) || seenRuntimeNames.has(skill.name)) continue;
        seenRuntimeNames.add(skill.name);
        skill.id = `${sourceRuntime}:${skill.id}`;
      }
      skill.lifecycle = lifecycle({ installed: authoritative ? true : null, enabled: authoritative ? true : null, sessionVisible: authoritative ? true : null, actualUsed: authoritative && actualUsedSkillNames ? actualUsedSkillNames.has(skill.name) : null });
      if (!seen.has(skill.id)) { seen.add(skill.id); seenSkillSources.add(skillSource); components.push(skill); }
    }
  }
  for (const entry of syntheticSkillEntries ?? []) {
    if (activeSkillNames && !activeSkillNames.has(String(entry.name))) continue;
    if (seenRuntimeNames.has(String(entry.name))) continue;
    seenRuntimeNames.add(String(entry.name));
    components.push(syntheticSkill(entry, runtime, { installed: true, enabled: true, sessionVisible: true, actualUsed: actualUsedSkillNames ? actualUsedSkillNames.has(String(entry.name)) : null }));
  }
  return {
    schemaVersion: "0.2",
    generatedAt: new Date().toISOString(),
    cwd: path.resolve(cwd),
    roots: uniqueRoots,
    runtime,
    authoritative: authoritative,
    analysisScope: authoritative ? "session-visible" : "runtime-roots",
    components: await Promise.all(components.sort((a, b) => a.id.localeCompare(b.id)).map(async (component) => {
      const canonicalSource = typeof component.source === "string"
        ? path.isAbsolute(component.source) ? await canonicalPath(component.source, scanCache) : await realpath(component.source).catch(() => component.source)
        : component.source;
      let auditChecks;
      if (component.kind === "skill") {
        const key = JSON.stringify([canonicalSource, cwd, home, component.reads, component.writes, component.metadataError, component.pluginRoot, component.tools, component.sideEffects]);
        if (!scanCache.audits.has(key)) scanCache.audits.set(key, auditSkill({ ...component, source: canonicalSource }, { cwd, home }));
        auditChecks = await scanCache.audits.get(key);
      }
      return { ...component, canonicalSource, ...(auditChecks ? { auditChecks } : {}), analysisScope: authoritative ? "session-visible" : "runtime-roots" };
    }))
  };
}

async function adapterFor(runtime, options) {
  if (runtime === "claude") return claudeRuntime(options);
  if (runtime === "pi") return piRuntime(options);
  if (runtime === "opencode") return opencodeRuntime(options);
  if (runtime === "openclaw") return openclawRuntime(options);
  return { roots: defaultRoots({ ...options, runtime }), authoritative: runtime === "hermes" };
}

export async function scanRuntime({ runtime = "all", cwd = process.cwd(), home = os.homedir(), hermesHome = process.env.HERMES_HOME, scanCache: providedScanCache = null } = {}) {
  if (runtime === "all") {
    const scanCache = providedScanCache ?? createScanCache();
    const inventories = await Promise.all(["codex", "hermes", "claude", "pi", "opencode", "openclaw", "skywork"].map((name) => scanRuntime({ runtime: name, cwd, home, hermesHome, scanCache })));
    return {
      schemaVersion: "0.2", generatedAt: new Date().toISOString(), cwd: path.resolve(cwd),
      runtime: "all",
      runtimeScopes: Object.fromEntries(inventories.map((item) => [item.runtime, item.analysisScope])),
      roots: [...new Set(inventories.flatMap((item) => item.roots))],
      authoritative: inventories.every((item) => item.authoritative === true),
      analysisScope: inventories.every((item) => item.authoritative === true) ? "session-visible" : "runtime-roots",
      components: inventories.flatMap((item) => item.components).sort((a, b) => a.id.localeCompare(b.id))
    };
  }
  const state = await adapterFor(runtime, { cwd, home, hermesHome });
  return scanRoots({ roots: state.roots, cwd, home, hermesHome, runtime, runtimeState: state, scanCache: providedScanCache });
}
