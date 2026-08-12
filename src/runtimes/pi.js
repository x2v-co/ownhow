import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; }
}

async function gitRoot(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function projectChain(cwd) {
  const chain = [];
  const stop = await gitRoot(cwd);
  let current = path.resolve(cwd);
  while (true) {
    chain.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

async function isTrusted(agentDir, cwd) {
  const trust = await readJson(path.join(agentDir, "trust.json"));
  let current = path.resolve(cwd);
  while (true) {
    if (trust[current] === true || trust[current] === false) return trust[current];
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function sourceOf(entry) { return typeof entry === "string" ? entry : entry?.source; }
function npmName(spec) {
  if (spec.startsWith("@")) return spec.match(/^(@[^/]+\/[^@]+)(?:@.+)?$/)?.[1] ?? spec;
  return spec.split("@")[0];
}
function packageIdentity(entry, base) {
  const source = sourceOf(entry) ?? "";
  if (source.startsWith("npm:")) return `npm:${npmName(source.slice(4))}`;
  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) return `git:${source.replace(/^git:/, "").replace(/^https?:\/\//, "").replace(/@[^/]+$/, "").replace(/\.git$/, "")}`;
  return `local:${path.resolve(base, source)}`;
}

function packagePath(entry, scope, { agentDir, cwd }) {
  const source = sourceOf(entry);
  if (!source) return null;
  const base = scope === "project" ? path.join(cwd, ".pi") : agentDir;
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    return path.join(base, "npm", "node_modules", npmName(spec));
  }
  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const clean = source.replace(/^git:/, "").replace(/^[a-z]+:\/\//, "").replace(/^git@/, "").replace(":", "/").replace(/@[^/]+$/, "").replace(/\.git$/, "");
    return path.join(base, "git", clean);
  }
  return path.resolve(scope === "project" ? path.join(cwd, ".pi") : agentDir, source);
}

function globRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
  return new RegExp(`^(?:${escaped})(?:/SKILL\\.md)?$`);
}

function enabledByPatterns(file, patterns, base) {
  const relative = path.relative(base, file).replaceAll(path.sep, "/");
  let enabled = true;
  for (const value of patterns.filter((item) => /^[!+-]/.test(item))) {
    const marker = value[0];
    const target = value.slice(1).replace(/^\.\//, "").replace(/\/$/, "");
    const matches = marker === "!" ? globRegex(target).test(relative) || globRegex(target).test(path.dirname(relative)) : [relative, path.dirname(relative), file.replaceAll(path.sep, "/"), path.dirname(file).replaceAll(path.sep, "/")].includes(target);
    if (matches) enabled = marker === "+" ? true : false;
  }
  return enabled;
}

async function discover(directory, mode = "agents", results = [], visited = new Set(), rootDirectory = path.resolve(directory)) {
  if (!(await exists(directory))) return results;
  let canonical;
  try { canonical = await realpath(directory); } catch { return results; }
  if (visited.has(canonical)) return results;
  visited.add(canonical);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return results; }
  const skill = entries.find((entry) => entry.name === "SKILL.md");
  if (skill) { results.push(path.join(directory, "SKILL.md")); return results; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const file = path.join(directory, entry.name);
    let info;
    try { info = entry.isSymbolicLink() ? await stat(file) : entry; } catch { continue; }
    if (info.isDirectory()) await discover(file, mode, results, visited, rootDirectory);
    else if (mode === "pi" && path.resolve(directory) === rootDirectory && entry.name.endsWith(".md")) results.push(file);
  }
  return results;
}

async function configuredSkillFiles(settings, base) {
  const files = [];
  for (const item of settings.skills ?? []) {
    if (/^[!+-]/.test(item) || item.includes("*") || item.includes("?")) continue;
    const location = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : path.resolve(base, item);
    try {
      const info = await stat(location);
      if (info.isFile()) files.push(location);
      else files.push(...await discover(location, "pi"));
    } catch {}
  }
  return files;
}

async function packageSkillFiles(entry, scope, context) {
  if (typeof entry === "object" && entry.skills?.length === 0) return [];
  const root = packagePath(entry, scope, context);
  if (!root || !(await exists(root))) return [];
  const manifest = await readJson(path.join(root, "package.json"));
  const declared = Array.isArray(manifest.pi?.skills) ? manifest.pi.skills : ["./skills"];
  const filters = typeof entry === "object" && Array.isArray(entry.skills) ? entry.skills : [];
  const files = [];
  for (const value of declared.filter((item) => !String(item).startsWith("!"))) {
    const location = path.resolve(root, String(value).replace(/[*!].*$/, ""));
    files.push(...await discover(location, "pi"));
  }
  return files.filter((file) => enabledByPatterns(file, [...declared, ...filters], root));
}

export async function piRuntime({ cwd = process.cwd(), home = os.homedir(), agentDir = process.env.PI_CODING_AGENT_DIR } = {}) {
  const resolvedAgentDir = path.resolve(agentDir || path.join(home, ".pi", "agent"));
  const trusted = await isTrusted(resolvedAgentDir, cwd);
  const chain = await projectChain(cwd);
  const userSettings = await readJson(path.join(resolvedAgentDir, "settings.json"));
  const projectSettings = trusted ? await readJson(path.join(cwd, ".pi", "settings.json")) : {};
  const roots = [];
  const skillFiles = [];
  const add = async (root, mode, patterns, base) => {
    roots.push(root);
    skillFiles.push(...(await discover(root, mode)).filter((file) => enabledByPatterns(file, patterns, base)));
  };

  if (trusted) {
    skillFiles.push(...await configuredSkillFiles(projectSettings, path.join(cwd, ".pi")));
    await add(path.join(cwd, ".pi", "skills"), "pi", projectSettings.skills ?? [], path.join(cwd, ".pi"));
    for (const directory of chain) await add(path.join(directory, ".agents", "skills"), "agents", projectSettings.skills ?? [], path.join(cwd, ".pi"));
  }
  skillFiles.push(...await configuredSkillFiles(userSettings, resolvedAgentDir));
  await add(path.join(resolvedAgentDir, "skills"), "pi", userSettings.skills ?? [], resolvedAgentDir);
  await add(path.join(home, ".agents", "skills"), "agents", userSettings.skills ?? [], resolvedAgentDir);

  const userPackages = (userSettings.packages ?? []).map((entry) => ({ entry, scope: "user" }));
  const projectPackages = trusted ? (projectSettings.packages ?? []).map((entry) => ({ entry, scope: "project" })) : [];
  const packages = [];
  const seen = new Map();
  for (const item of [...projectPackages, ...userPackages]) {
    const identity = packageIdentity(item.entry, item.scope === "project" ? path.join(cwd, ".pi") : resolvedAgentDir);
    if (seen.has(identity)) {
      if (item.scope === "user" && typeof packages[seen.get(identity)].entry === "object" && packages[seen.get(identity)].entry.autoload === false) packages.push(item);
      continue;
    }
    seen.set(identity, packages.length); packages.push(item);
  }
  for (const item of packages) {
    const root = packagePath(item.entry, item.scope, { agentDir: resolvedAgentDir, cwd });
    if (root) roots.push(root);
    skillFiles.push(...await packageSkillFiles(item.entry, item.scope, { agentDir: resolvedAgentDir, cwd }));
  }
  return { roots: [...new Set(roots.map((root) => path.resolve(root)))], skillFiles: [...new Set(skillFiles.map((file) => path.resolve(file)))], authoritative: true, trusted };
}
