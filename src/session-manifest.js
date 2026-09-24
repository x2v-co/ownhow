import { readFile } from "node:fs/promises";
import path from "node:path";

// Session manifests are a small, local-only contract between an Agent host and
// OwnHow. The older { runtime, skillFiles } shape remains valid; version 1
// additionally permits pathless host-reported Skills and an optional,
// exhaustive list of Skills the host actually used during the session.
export const SESSION_MANIFEST_SCHEMA_VERSION = "1";
export const SESSION_MANIFEST_RUNTIMES = new Set(["codex", "hermes", "claude", "pi", "opencode", "openclaw", "skywork"]);
const MAX_ENTRIES = 10_000;

function error(message) { throw new Error(`Invalid session manifest: ${message}`); }

function text(value, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) error(`${field} must be a non-empty string`);
  return value.trim();
}

function absolutePath(value, field) {
  if (typeof value !== "string" || !value.length || value.includes("\u0000")) error(`${field} must be a non-empty string`);
  const file = value;
  if (!path.isAbsolute(file)) error(`${field} must be an absolute path`);
  return path.resolve(file);
}

function list(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) error(`${field} must be an array`);
  if (value.length > MAX_ENTRIES) error(`${field} has too many entries`);
  return value;
}

function uniqueStrings(value, field) {
  return [...new Set(list(value, field).map((entry) => text(entry, field)))];
}

function normalizedSkillEntries(raw) {
  const skillFiles = [];
  const syntheticSkills = [];
  const seenFiles = new Set();
  const seenNames = new Set();
  if (raw.skills == null && raw.skillFiles == null) error("skillFiles or skills is required");
  const entries = [
    ...list(raw.skillFiles, "skillFiles"),
    ...list(raw.skills, "skills")
  ];
  if (entries.length > MAX_ENTRIES) error("skills has too many entries");
  for (const entry of entries) {
    if (typeof entry === "string") {
      const file = absolutePath(entry, "skillFiles entry");
      if (!seenFiles.has(file)) { seenFiles.add(file); skillFiles.push(file); }
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) error("skills entries must be paths or objects");
    const fileValue = entry.file ?? entry.path ?? entry.skillFile;
    if (fileValue != null) {
      const file = absolutePath(fileValue, "skills.file");
      if (!seenFiles.has(file)) { seenFiles.add(file); skillFiles.push(file); }
      continue;
    }
    const name = text(entry.name, "skills.name");
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const metadata = entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata) ? entry.metadata : {};
    syntheticSkills.push({
      name,
      description: typeof entry.description === "string" ? entry.description : "",
      source: typeof entry.source === "string" ? entry.source : `${raw.runtime}:session:${name}`,
      version: typeof entry.version === "string" ? entry.version : "unversioned",
      metadata
    });
  }
  return { skillFiles, syntheticSkills };
}

function normalizedPlugins(raw) {
  return list(raw.plugins, "plugins").map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) error("plugins entries must be objects");
    return {
      name: text(entry.name, "plugins.name"),
      version: typeof entry.version === "string" ? entry.version : "unversioned",
      description: typeof entry.description === "string" ? entry.description : "",
      source: typeof entry.source === "string" ? entry.source : undefined,
      metadata: entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata) ? entry.metadata : {}
    };
  });
}

/** Validate and normalize a host supplied manifest without touching the filesystem. */
export function normalizeSessionManifest(raw, { runtime = null } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) error("top level must be an object");
  const manifestRuntime = text(raw.runtime, "runtime");
  if (!SESSION_MANIFEST_RUNTIMES.has(manifestRuntime)) error(`unsupported runtime ${manifestRuntime}`);
  if (runtime && runtime !== manifestRuntime) error(`runtime ${manifestRuntime} does not match --runtime ${runtime}`);
  const schemaVersion = String(raw.schemaVersion ?? "0");
  if (!/^0(?:\.\d+)?$|^1(?:\.\d+)?$/.test(schemaVersion)) error(`unsupported schemaVersion ${schemaVersion}`);
  const entries = normalizedSkillEntries({ ...raw, runtime: manifestRuntime });
  const activeSkillNames = uniqueStrings(raw.activeSkillNames, "activeSkillNames");
  const actualUsedProvided = raw.actualUsedSkillNames != null || raw.usedSkillNames != null;
  const actualUsedValues = [
    ...list(raw.actualUsedSkillNames, "actualUsedSkillNames"),
    ...list(raw.usedSkillNames, "usedSkillNames")
  ];
  const actualUsedSkillNames = actualUsedProvided ? uniqueStrings(actualUsedValues, "actualUsedSkillNames") : null;
  const generatedAt = raw.generatedAt == null ? null : text(raw.generatedAt, "generatedAt");
  if (generatedAt && !Number.isFinite(Date.parse(generatedAt))) error("generatedAt must be an ISO timestamp");
  // Keep this object deliberately small. A host must never use a manifest as
  // a transport for task text, receipts, or arbitrary execution instructions.
  return {
    schemaVersion,
    runtime: manifestRuntime,
    generatedAt,
    skillFiles: entries.skillFiles,
    syntheticSkills: entries.syntheticSkills,
    activeSkillNames,
    actualUsedSkillNames,
    plugins: normalizedPlugins(raw)
  };
}

export async function loadSessionManifest(file, options = {}) {
  const manifestPath = path.resolve(text(file, "manifest path"));
  let raw;
  try { raw = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (cause) { throw new Error(`Unable to read session manifest ${manifestPath}: ${cause.message}`); }
  return normalizeSessionManifest(raw, options);
}

/** Stable doctor/analysis lifecycle counts shared by all command surfaces. */
export function summarizeLifecycle(components = []) {
  const lifecycle = { discovered: 0, installed: 0, enabled: 0, sessionVisible: 0, actualUsed: 0, unknownInstallation: 0, unknownEnabled: 0, unknownSessionVisibility: 0, unknownActualUsed: 0 };
  const skills = components.filter((item) => item?.kind === "skill");
  for (const skill of skills) {
    const state = skill.lifecycle ?? {};
    for (const key of ["discovered", "installed", "enabled", "sessionVisible", "actualUsed"]) lifecycle[key] += state[key] === true ? 1 : 0;
    for (const [key, field] of [["unknownInstallation", "installed"], ["unknownEnabled", "enabled"], ["unknownSessionVisibility", "sessionVisible"], ["unknownActualUsed", "actualUsed"]]) lifecycle[key] += state[field] == null ? 1 : 0;
  }
  const unknown = lifecycle.unknownInstallation + lifecycle.unknownEnabled + lifecycle.unknownSessionVisibility;
  return {
    ...lifecycle,
    totalSkills: skills.length,
    confirmed: unknown === 0,
    actualUsedConfirmed: lifecycle.unknownActualUsed === 0,
    visibility: lifecycle.sessionVisible === skills.length && skills.length > 0 ? "confirmed" : lifecycle.unknownSessionVisibility ? "unknown" : "partial"
  };
}
