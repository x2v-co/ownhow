import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";

const exec = promisify(execFile);

async function defaultRun(command, args, options) {
  const { stdout } = await exec(command, args, { cwd: options.cwd, env: options.env, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function readConfig(stateDir) {
  for (const name of ["openclaw.json", "config.json"]) {
    try { return JSON.parse(await readFile(path.join(stateDir, name), "utf8")); } catch {}
  }
  return {};
}

export async function openclawRuntime({ cwd = process.cwd(), home = os.homedir(), env = process.env, run = defaultRun } = {}) {
  const stateDir = path.resolve(env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"));
  const config = await readConfig(stateDir);
  const configuredWorkspace = config.workspace ?? config.agents?.defaults?.workspace;
  const fallbackWorkspace = path.resolve(configuredWorkspace || env.OPENCLAW_HOME || path.join(stateDir, "workspace"));
  const extraDirs = Array.isArray(config.skills?.load?.extraDirs) ? config.skills.load.extraDirs : [];
  const fallbackRoots = [
    path.join(fallbackWorkspace, "skills"),
    path.join(fallbackWorkspace, ".agents", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(stateDir, "skills"),
    ...extraDirs.map((item) => path.resolve(fallbackWorkspace, String(item)))
  ];

  try {
    const [report, pluginReport] = await Promise.all([
      run("openclaw", ["skills", "list", "--eligible", "--json"], { cwd, env }),
      run("openclaw", ["plugins", "list", "--json"], { cwd, env }).catch(() => ({ plugins: [] }))
    ]);
    const active = Array.isArray(report.skills) ? report.skills.filter((item) => item?.eligible && !item.blockedByAgentFilter) : [];
    const loadedPlugins = Array.isArray(pluginReport.plugins) ? pluginReport.plugins.filter((item) => item?.enabled && item.status === "loaded") : [];
    const roots = [
      path.join(path.resolve(report.workspaceDir || fallbackWorkspace), "skills"),
      path.join(path.resolve(report.workspaceDir || fallbackWorkspace), ".agents", "skills"),
      path.join(home, ".agents", "skills"),
      path.resolve(report.managedSkillsDir || path.join(stateDir, "skills")),
      ...extraDirs.map((item) => path.resolve(fallbackWorkspace, String(item))),
      ...loadedPlugins.filter((item) => item.rootDir).map((item) => path.join(path.resolve(item.rootDir), "skills"))
    ];
    const plugins = loadedPlugins.map((item) => ({
      name: String(item.id ?? item.name), version: String(item.version ?? "unversioned"), description: String(item.name ?? ""),
      source: String(item.rootDir ?? item.source ?? `openclaw:plugin:${item.id}`), metadata: item
    }));
    return {
      roots: [...new Set(roots.map((root) => path.resolve(root)))],
      activeSkillNames: new Set(active.map((item) => String(item.name))),
      syntheticSkills: active.map((item) => ({ name: String(item.name), description: String(item.description ?? ""), source: `openclaw:${item.source ?? "runtime"}`, metadata: item })),
      plugins,
      authoritative: true
    };
  } catch {
    return { roots: [...new Set(fallbackRoots.map((root) => path.resolve(root)))], authoritative: false };
  }
}
