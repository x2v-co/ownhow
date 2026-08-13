import { access, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; }
}

function normalized(file) {
  return path.resolve(file).replaceAll(path.sep, "/").replace(/\/+$/, "") || "/";
}

function contains(parent, child) {
  const base = normalized(parent);
  const target = normalized(child);
  return target === base || target.startsWith(`${base}/`);
}

async function projectChain(cwd) {
  const chain = [];
  let current = path.resolve(cwd);
  while (true) {
    chain.push(current);
    if (await exists(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(cwd)];
    current = parent;
  }
  return chain;
}

async function readSettings({ home, chain }) {
  const user = await readJson(path.join(home, ".claude", "settings.json"));
  const skillOverrides = { ...(user.skillOverrides ?? {}) };
  const enabledPlugins = { ...(user.enabledPlugins ?? {}) };

  for (const directory of [...chain].reverse()) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const settings = await readJson(path.join(directory, ".claude", name));
      Object.assign(skillOverrides, settings.skillOverrides ?? {});
      Object.assign(enabledPlugins, settings.enabledPlugins ?? {});
    }
  }
  return { skillOverrides, enabledPlugins, userEnabledPlugins: user.enabledPlugins ?? {} };
}

function newest(entries) {
  return [...entries].sort((a, b) => String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")))[0];
}

async function defaultEnabled(entry) {
  const manifest = await readJson(path.join(entry.installPath ?? "", ".claude-plugin", "plugin.json"));
  return manifest.defaultEnabled !== false;
}

async function activePluginRoots({ home, cwd, settings }) {
  const installed = await readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const roots = [];
  for (const [pluginId, installations] of Object.entries(installed.plugins ?? {})) {
    if (!Array.isArray(installations) || !installations.length || settings.enabledPlugins[pluginId] === false) continue;
    const projectEntries = installations.filter((entry) => ["project", "local"].includes(entry.scope) && entry.projectPath && contains(entry.projectPath, cwd));
    const closestLength = Math.max(0, ...projectEntries.map((entry) => normalized(entry.projectPath).length));
    const project = newest(projectEntries.filter((entry) => normalized(entry.projectPath).length === closestLength));
    const user = newest(installations.filter((entry) => entry.scope === "user"));
    let selected = project ?? user;
    if (!selected?.installPath) continue;

    const explicitlyEnabled = settings.enabledPlugins[pluginId] === true || (selected.scope === "user" && settings.userEnabledPlugins[pluginId] === true);
    if (!explicitlyEnabled && !(await defaultEnabled(selected))) continue;
    roots.push(path.resolve(selected.installPath));
  }
  return roots;
}

export async function claudeRuntime({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const chain = await projectChain(cwd);
  const settings = await readSettings({ home, chain });
  const skillRoots = [path.join(home, ".claude", "skills"), ...chain.map((directory) => path.join(directory, ".claude", "skills"))];
  const pluginRoots = await activePluginRoots({ home, cwd, settings });
  return {
    roots: [...new Set([...skillRoots, ...pluginRoots].map((root) => path.resolve(root)))],
    authoritative: true,
    skillRoots: new Set(skillRoots.map((root) => path.resolve(root))),
    pluginRoots: new Set(pluginRoots),
    disabledSkills: new Set(Object.entries(settings.skillOverrides).filter(([, value]) => value === "off").map(([name]) => name)),
    disabledPlugins: new Set(Object.entries(settings.enabledPlugins).filter(([, value]) => value === false).map(([name]) => name))
  };
}
