import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm, lstat, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJson, writeJson } from "./store.js";
import { parseFrontmatter } from "./scanner.js";

const exec = promisify(execFile);
export const RELEASE_URL = "https://github.com/x2v-co/ownhow/releases/latest/download/ownhow-update.json";
export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NOTICE = "ownhow:update:v1:";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exists = async (file) => Boolean(await lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; }));
export function compareVersions(a, b) {
  if (!SEMVER.test(a) || !SEMVER.test(b)) throw new Error("Only stable x.y.z release versions are supported");
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function updateNotice(version) {
  compareVersions(version, version);
  return `${NOTICE}${version}`;
}
function noticeVersion(value) {
  if (!value?.startsWith(NOTICE)) throw new Error("Invalid update notice");
  const version = value.slice(NOTICE.length); compareVersions(version, version); return version;
}
function releaseUrl(version, file) { return `https://github.com/x2v-co/ownhow/releases/download/v${version}/${file}`; }
async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": "OwnHow-Updater" } });
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Release download exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function validateBundle(bundle, version) {
  if (bundle.schemaVersion !== 1 || bundle.version !== version || !Array.isArray(bundle.files) || bundle.files.length > 500) throw new Error("Invalid release bundle");
  const files = new Map();
  for (const file of bundle.files) {
    if (typeof file.path !== "string" || !/^(src\/|skills\/ownhow-governance\/|package\.json$|LICENSE$)/.test(file.path) || file.path.split("/").some((part) => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(file.path) || typeof file.content !== "string" || files.has(file.path)) throw new Error("Unsafe or duplicate release path");
    files.set(file.path, file.content);
  }
  const pkg = JSON.parse(files.get("package.json") ?? "null");
  if (pkg?.name !== "ownhow" || pkg.version !== version || pkg.type !== "module" || !files.has("src/cli.js")) throw new Error("Release package identity mismatch");
  const skill = parseFrontmatter(files.get("skills/ownhow-governance/SKILL.md") ?? "");
  if (skill.name !== "ownhow-governance" || skill.version !== version) throw new Error("CLI and Skill release versions must match");
  return files;
}
async function smoke(root, run = exec) {
  const cli = path.join(root, "src/cli.js");
  const args = ["--runtime", "codex", "--root", path.join(root, "skills"), "--state", path.join(root, ".smoke-state"), "--json"];
  const doctor = JSON.parse((await run(process.execPath, [cli, "doctor", ...args], { timeout: 15000 })).stdout);
  if (doctor.metadataErrors.length) throw new Error("Release doctor found metadata errors");
  for (const task of ["govern local AI skills and personal methods", "检查我的本地 Skills 并分析能力重叠"]) {
    const plan = JSON.parse((await run(process.execPath, [cli, "resolve", task, ...args], { timeout: 15000 })).stdout);
    if (plan.primary?.name !== "ownhow-governance") throw new Error("Release resolver smoke check failed");
  }
}
async function writableTarget(root, explicit, stateDir) {
  if (root === path.parse(root).root || root === os.homedir()) throw new Error("Unsafe install directory");
  if (await exists(root)) {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Install directory must be a real directory");
    if (await exists(path.join(root, ".git"))) throw new Error("Source checkout detected; update your checkout separately or select a new --install-dir");
    const pkg = await readJson(path.join(root, "package.json"));
    if (pkg?.name !== "ownhow") throw new Error("Install directory is not an OwnHow package");
    if (!explicit && path.basename(path.dirname(root)) !== "node_modules") throw new Error("Unknown install source; specify --install-dir explicitly");
  }
  if (stateDir === root || stateDir.startsWith(`${root}${path.sep}`) || root.startsWith(`${stateDir}${path.sep}`)) throw new Error("OwnHow state must be outside the install directory");
}
async function skillTarget(directory, root) {
  if (!directory) return null;
  const target = path.resolve(directory);
  if (target === root || target.startsWith(`${root}${path.sep}`) || root.startsWith(`${target}${path.sep}`)) throw new Error("Skill destination must be separate from the CLI installation");
  if (/[/\\](\.codex|\.claude|\.skywork)[/\\]plugins[/\\]|[/\\]plugins[/\\]cache[/\\]/.test(target)) throw new Error("Plugin caches are host-managed; select a standalone Skill directory instead");
  if (await exists(target)) {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Skill symlink is managed elsewhere; update its source or select a new destination");
    const metadata = parseFrontmatter(await readFile(path.join(target, "SKILL.md"), "utf8"));
    if (metadata.name !== "ownhow-governance") throw new Error("Refusing to replace a different Skill");
  }
  return target;
}
// Journal each destination before activation. Recovery also handles a process
// ending between rename and journal update, using backup presence as evidence.
async function restore(journalFile) {
  const journal = await readJson(journalFile);
  if (!journal) return false;
  for (const item of [...journal.targets].reverse()) {
    if (await exists(item.backup)) {
      await rm(item.target, { recursive: true, force: true });
      await rename(item.backup, item.target);
    } else if (!item.existed && !(await exists(item.staged))) {
      await rm(item.target, { recursive: true, force: true });
    }
    await rm(item.staged, { recursive: true, force: true });
  }
  await rm(journalFile, { force: true });
  return true;
}
export async function upgrade(options, stateDir, dependencies = {}) {
  const fetchBytes = dependencies.download ?? download;
  const runSmoke = dependencies.smoke ?? smoke;
  const currentRoot = dependencies.currentRoot ?? PACKAGE_ROOT;
  const current = await readJson(path.join(currentRoot, "package.json"));
  const configFile = path.join(stateDir, "updates", "config.json");
  const config = await readJson(configFile, {});
  const root = path.resolve(options["install-dir"] ?? config.installDir ?? currentRoot);
  const automatic = Boolean(options.auto);
  const modes = ["check", "apply", "auto", "enable-auto", "disable-auto", "recover"].filter((key) => options[key]);
  if (modes.length > 1) throw new Error("Select one upgrade mode: check, apply, auto, enable-auto, disable-auto, or recover");
  if (options.notice && options.version) throw new Error("Use either --notice or --version");
  if (automatic && (options["install-dir"] || options["skill-dir"])) throw new Error("Automatic updates use enrolled destinations; reconfigure with --enable-auto first");
  const mutating = options.apply || automatic || options["enable-auto"] || options["disable-auto"] || options.recover;
  const updateDir = path.join(stateDir, "updates");
  const lock = path.join(updateDir, "lock");
  const journalFile = path.join(updateDir, "transaction.json");
  let locked = false;
  if (mutating) {
    await mkdir(updateDir, { recursive: true });
    try { await mkdir(lock); locked = true; } catch (error) { if (error.code === "EEXIST") throw new Error("Another updater holds updates/lock. After confirming it stopped, remove that lock and run upgrade --recover."); throw error; }
  }
  try {
    if (mutating && await restore(journalFile)) return { status: "recovered", retryRequired: true, sessionReloadRequired: true };
    if (options.recover) return { status: "no_recovery_needed" };
    if (options["disable-auto"]) { await writeJson(configFile, { ...config, enabled: false }); return { status: "auto_disabled" }; }
    if (automatic && !config.enabled) return { status: "auto_disabled" };
    if (options.apply || automatic || options["enable-auto"]) await writableTarget(root, Boolean(options["install-dir"] || config.installDir), path.resolve(stateDir));
    const requestedSkillDir = options["skill-dir"] ?? config.skillDir;
    const resolvedSkillDir = requestedSkillDir ? path.resolve(requestedSkillDir) : null;
    if (resolvedSkillDir && (path.resolve(stateDir) === resolvedSkillDir || path.resolve(stateDir).startsWith(`${resolvedSkillDir}${path.sep}`) || resolvedSkillDir.startsWith(`${path.resolve(stateDir)}${path.sep}`))) throw new Error("Skill destination must be outside OwnHow state");
    const skillDir = await skillTarget(resolvedSkillDir, root);
    if (options["enable-auto"]) {
      await writeJson(configFile, { ...config, enabled: true, policy: "patch", installDir: root, skillDir });
      return { status: "auto_enabled", policy: "patch", command: "ownhow upgrade --auto --json", note: "Host must invoke this command at task boundaries; no background daemon is installed." };
    }
    const requested = options.notice ? noticeVersion(options.notice) : options.version;
    if (requested) compareVersions(requested, requested);
    if (automatic && !requested && Date.now() - Date.parse(config.lastCheckedAt ?? "") < 86400000) return { status: "check_throttled" };
    const manifest = JSON.parse((await fetchBytes(requested ? releaseUrl(requested, "ownhow-update.json") : RELEASE_URL, 64 * 1024)).toString());
    compareVersions(manifest.version, manifest.version);
    if (manifest.schemaVersion !== 1 || manifest.channel !== "stable" || !/^[a-f0-9]{64}$/.test(manifest.sha256) || (requested && manifest.version !== requested)) throw new Error("Invalid release manifest");
    const installed = await readJson(path.join(root, "package.json"), current);
    const targetVersion = manifest.version;
    const report = { currentVersion: installed.version, targetVersion, installDir: root, skillDir, skillDelivery: skillDir ? "standalone" : "bundled-only", pluginUpdateRequired: !skillDir, sessionReloadRequired: false, sessionLoadedVersion: "unknown", notice: updateNotice(targetVersion) };
    if (compareVersions(targetVersion, installed.version) < 0) throw new Error("Refusing to downgrade OwnHow");

    if (automatic && targetVersion.split(".").slice(0, 2).join(".") !== installed.version.split(".").slice(0, 2).join(".")) return { ...report, status: "approval_required", reason: "Automatic updates allow patch versions only" };
    let skillVersion = null;
    if (skillDir && await exists(skillDir)) skillVersion = parseFrontmatter(await readFile(path.join(skillDir, "SKILL.md"), "utf8")).version ?? null;
    if (await exists(root) && targetVersion === installed.version && (!skillDir || skillVersion === targetVersion)) {
      if (automatic) await writeJson(configFile, { ...config, lastCheckedAt: new Date().toISOString() });
      return { ...report, status: "up_to_date", skillVersion: skillVersion ?? installed.version };
    }
    if (!options.apply && !automatic) return { ...report, status: "update_available", skillVersion };
    const bytes = await fetchBytes(releaseUrl(targetVersion, "ownhow-bundle.json"), 8 * 1024 * 1024);
    if (hash(bytes) !== manifest.sha256) throw new Error("Release bundle checksum mismatch");
    const files = validateBundle(JSON.parse(bytes.toString()), targetVersion);
    const suffix = `.ownhow-update-${process.pid}-${Date.now()}`;
    const targets = [{ target: root, staged: root + suffix, backup: root + suffix + ".backup", existed: await exists(root) }];
    if (skillDir) targets.push({ target: skillDir, staged: skillDir + suffix, backup: skillDir + suffix + ".backup", existed: await exists(skillDir) });
    try {
      await mkdir(targets[0].staged, { recursive: true });
      for (const [file, content] of files) {
        const destination = path.join(targets[0].staged, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, content, { mode: file === "src/cli.js" ? 0o755 : 0o644 });
      }
      await runSmoke(targets[0].staged);
      if (skillDir) await cp(path.join(targets[0].staged, "skills/ownhow-governance"), targets[1].staged, { recursive: true });
      await writeJson(journalFile, { targets });
      for (const item of targets) {
        if (item.existed) await rename(item.target, item.backup);
        await rename(item.staged, item.target);
      }
      await runSmoke(root);
      // Removing the journal commits the transaction. Backups are retained for inspection.
      if (automatic) await writeJson(configFile, { ...config, lastCheckedAt: new Date().toISOString() });
      await rm(journalFile);
      return { ...report, status: "updated", cliVersion: targetVersion, skillVersion: targetVersion, verification: "passed", backups: targets.filter((item) => item.existed).map((item) => item.backup), cliPath: path.join(root, "src/cli.js"), sessionReloadRequired: true };
    } catch (error) {
      await restore(journalFile);
      for (const item of targets) await rm(item.staged, { recursive: true, force: true });
      throw error;
    }
  } finally { if (locked) await rm(lock, { recursive: true, force: true }); }
}
