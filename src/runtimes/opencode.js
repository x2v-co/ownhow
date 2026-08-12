import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { access, mkdtemp, open, readFile, rm } from "node:fs/promises";

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function projectChain(cwd) {
  const chain = [];
  let current = path.resolve(cwd);
  while (true) {
    chain.push(current);
    if (await exists(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

async function defaultRun(command, args, options) {
  // OpenCode can exit before a large piped JSON write drains. A regular file
  // avoids the pipe backpressure bug while preserving its official output.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-opencode-"));
  const outputFile = path.join(temporary, "output.json");
  const output = await open(outputFile, "w");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", output.fd, "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)));
    });
    await output.close();
    return JSON.parse(await readFile(outputFile, "utf8"));
  } finally {
    await output.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

function enabledFlag(value) {
  return ["1", "true"].includes(String(value ?? "").toLowerCase());
}

export async function opencodeRuntime({ cwd = process.cwd(), home = os.homedir(), env = process.env, run = defaultRun } = {}) {
  const chain = await projectChain(cwd);
  const claudeDisabled = enabledFlag(env.OPENCODE_DISABLE_CLAUDE_CODE) || enabledFlag(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS);
  const external = enabledFlag(env.OPENCODE_DISABLE_EXTERNAL_SKILLS) ? [] : [
    ...(claudeDisabled ? [] : [path.join(home, ".claude", "skills")]),
    path.join(home, ".agents", "skills"),
    ...chain.flatMap((directory) => [
      ...(claudeDisabled ? [] : [path.join(directory, ".claude", "skills")]),
      path.join(directory, ".agents", "skills")
    ])
  ];
  const roots = [...external, path.join(home, ".config", "opencode"), ...[...chain].reverse().map((directory) => path.join(directory, ".opencode"))];

  try {
    const [entries, config] = await Promise.all([
      run("opencode", ["debug", "skill"], { cwd, env }),
      run("opencode", ["debug", "config"], { cwd, env }).catch(() => ({}))
    ]);
    if (!Array.isArray(entries)) throw new Error("Unexpected OpenCode skill output");
    const skillFiles = [];
    const syntheticSkills = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string") continue;
      if (typeof entry.location === "string" && await exists(entry.location)) skillFiles.push(path.resolve(entry.location));
      else syntheticSkills.push({ name: entry.name, description: String(entry.description ?? ""), source: String(entry.location ?? "opencode:builtin") });
    }
    const plugins = Array.isArray(config?.plugin) ? [...new Map(config.plugin.map((source) => {
      const value = String(source);
      const name = value.startsWith("file:") ? path.basename(value).replace(/\.[^.]+$/, "") : value.replace(/@[^/@]+$/, "");
      return [name, { name, source: value, description: "OpenCode configured Plugin" }];
    })).values()] : [];
    return { roots: [...new Set(roots.map((root) => path.resolve(root)))], skillFiles, syntheticSkills, plugins, authoritative: true };
  } catch {
    return { roots: [...new Set(roots.map((root) => path.resolve(root)))], authoritative: false };
  }
}
