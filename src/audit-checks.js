import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";

export const REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ id: "python_bytecode", name: "Stale/mismatched Python bytecode", required: true, reference: "https://arxiv.org/abs/2610.10612" }),
  Object.freeze({ id: "cross_session_residue", name: "Cross-session file residue", required: true, reference: "https://arxiv.org/abs/2610.13227" })
]);

const MAX_ENTRIES = 10000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const inside = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
const issue = (reason, file, message) => ({ reason, path: file, message });
const result = (id, inspected, findings, limitations) => ({ id, required: true, status: findings.length ? "findings" : limitations.length ? "unknown" : "pass", inspected, findings, limitations });

// Artifact inspection is separate from runtime discovery: caches, temporary
// directories and build outputs must not hide files inside a discovered Skill.
async function artifacts(root) {
  const files = [], limitations = [];
  let entriesSeen = 0;
  async function visit(directory, depth) {
    if (depth > 32 || entriesSeen >= MAX_ENTRIES) {
      limitations.push(issue("scan_limit", directory, "Artifact traversal limit reached."));
      return;
    }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { limitations.push(issue("unreadable_directory", directory, "Cannot inspect directory.")); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      if (++entriesSeen > MAX_ENTRIES) {
        limitations.push(issue("scan_limit", directory, "Artifact traversal limit reached."));
        break;
      }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile()) files.push(file);
      else limitations.push(issue("uninspected_special_file", file, "Symlinks and special files are not followed during artifact inspection."));
    }
  }
  await visit(root, 0);
  return { files, limitations };
}

function sourceForBytecode(file) {
  const directory = path.dirname(file);
  if (path.basename(directory) !== "__pycache__") return file.slice(0, -1);
  const match = path.basename(file).match(/^(.+?)\.[^.]+(?:\.opt-[^.]+)?\.pyc$/);
  return path.join(path.dirname(directory), match ? `${match[1]}.py` : path.basename(file).slice(0, -1));
}

// Only a fixed helper runs. -I -S excludes the Skill/cwd, user site packages,
// PYTHONPATH and startup hooks. Source bytes travel over stdin as data; neither
// source nor bytecode is imported, unmarshalled or executed. Hash algorithms
// differ between Python releases, so foreign magic must remain unverified.
const HASH_HELPER = `import importlib.util, json, sys
data = json.load(sys.stdin)
if data['magic'] != importlib.util.MAGIC_NUMBER.hex():
    print(json.dumps({'reason': 'unsupported_hash_version'}))
else:
    print(json.dumps({'hash': importlib.util.source_hash(bytes.fromhex(data['source'])).hex()}))
`;
function pythonSourceHash(magic, source) {
  return new Promise((resolve) => {
    const child = execFile("python3", ["-I", "-S", "-c", HASH_HELPER], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) return resolve({ reason: "hash_verifier_unavailable" });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ reason: "hash_verifier_unavailable" }); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ magic: magic.toString("hex"), source: source.toString("hex") }));
  });
}

async function bytecodeCheck(root, files, traversalLimitations, hashSource) {
  const findings = [], limitations = [...traversalLimitations];
  const bytecode = files.filter((file) => file.endsWith(".pyc"));
  for (const file of bytecode) {
    const source = sourceForBytecode(file);
    const fail = (reason, message, evidence = {}) => findings.push({ ...issue(reason, file, message), severity: "high", sourcePath: source, ...evidence });
    let sourceStat;
    try { sourceStat = await stat(source); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") fail("missing_source", "Orphan Python bytecode is shipped without its corresponding source.");
      else limitations.push(issue("unreadable_source", source, "Cannot inspect corresponding source."));
      continue;
    }
    if (!sourceStat.isFile()) { fail("missing_source", "Corresponding Python source is not a regular file."); continue; }
    let handle;
    try {
      if (!inside(root, await realpath(source)) || !(await lstat(source)).isFile()) {
        limitations.push(issue("source_outside_skill", source, "Source resolves outside the Skill or through a symlink."));
        continue;
      }
      handle = await open(file, "r");
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, 0);
      if (bytesRead < 8 || header[2] !== 13 || header[3] !== 10) { fail("invalid_header", "Python bytecode has a truncated or invalid header."); continue; }
      const magic = header.readUInt16LE(0);
      const headerSize = magic >= 3392 && magic < 5000 ? 16 : magic >= 3200 && magic < 3392 ? 12 : magic >= 3000 && magic < 3200 || magic === 62211 ? 8 : null;
      if (!headerSize) { limitations.push(issue("unsupported_magic", file, "Unrecognized Python bytecode format.")); continue; }
      if (bytesRead < headerSize || (await handle.stat()).size <= headerSize) { fail("invalid_header", "Python bytecode is truncated or has no body."); continue; }
      const flags = headerSize === 16 ? header.readUInt32LE(4) : 0;
      if (flags !== 0 && flags !== 1 && flags !== 3) { fail("invalid_flags", "Python bytecode contains invalid PEP 552 flags."); continue; }
      if (flags & 1) {
        if (sourceStat.size > MAX_SOURCE_BYTES) { limitations.push(issue("source_size_limit", source, "Source exceeds the hash verification size limit.")); continue; }
        const verified = await hashSource(header.subarray(0, 4), await readFile(source));
        if (!verified.hash) { limitations.push(issue(verified.reason ?? "hash_verifier_unavailable", file, "PEP 552 source hash could not be verified with local Python.")); continue; }
        const embeddedHash = header.subarray(8, 16).toString("hex");
        if (embeddedHash !== verified.hash) fail("hash_mismatch", "PEP 552 bytecode hash differs from the reviewed source.", { embeddedHash, sourceHash: verified.hash, checkedHash: Boolean(flags & 2) });
      } else {
        const offset = headerSize === 16 ? 8 : 4;
        const embeddedMtime = header.readUInt32LE(offset);
        const sourceMtime = Math.floor(sourceStat.mtimeMs / 1000) >>> 0;
        const embeddedSize = headerSize >= 12 ? header.readUInt32LE(offset + 4) : null;
        const sourceSize = sourceStat.size >>> 0;
        if (embeddedMtime !== sourceMtime || embeddedSize !== null && embeddedSize !== sourceSize) {
          fail("timestamp_size_mismatch", "Python bytecode source timestamp or size differs from the reviewed source.", { embeddedMtime, sourceMtime, embeddedSize, sourceSize });
        }
      }
    } catch { limitations.push(issue("unreadable_artifact", file, "Cannot inspect bytecode or corresponding source.")); }
    finally { await handle?.close(); }
  }
  return result("python_bytecode", bytecode.length, findings, limitations);
}

const RESIDUE_DIRECTORIES = new Set([
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", "cache", "caches",
  ".tmp", "tmp", ".temp", "temp", ".review", ".smoke", "output", "outputs", "out", "build", "dist",
  ".state", "state", ".session", "session", ".sessions", "sessions", ".logs", "logs"
]);
function residuePath(root, file) {
  const parts = path.relative(root, file).toLowerCase().split(path.sep);
  return parts.slice(0, -1).some((part) => RESIDUE_DIRECTORIES.has(part))
    || /\.(?:pyc|tmp|temp|bak|log|cache|swp|swo)$/.test(parts.at(-1))
    || /^(?:\.?session(?:[-_.]state)?|\.?state|memory|history|last[-_]run|checkpoint)(?:[-_.].*)?\.(?:jsonl?|db|sqlite3?|pickle|pkl)$/.test(parts.at(-1));
}

function declaredPath(value, root, { cwd, home }) {
  let target = String(value).trim();
  if (!target || /[\x00-\x1f*?\[\]<>`]|:\/\//.test(target)) return null;
  const variables = { HOME: home, WORKSPACE: cwd, CWD: cwd, SKILL_DIR: root };
  target = target.replace(/\$\{(HOME|WORKSPACE|CWD|SKILL_DIR)\}|\$(HOME|WORKSPACE|CWD|SKILL_DIR)\b/g, (_, braced, bare) => variables[braced ?? bare]);
  if (target === "~") target = home;
  else if (target.startsWith("~/")) target = path.join(home, target.slice(2));
  if (/[${}~]/.test(target) || !path.isAbsolute(target) && !/[/.\\]/.test(target)) return null;
  return path.resolve(root, target);
}

// Resolve existing ancestors too: a declared write through an internal symlink
// can escape the Skill even when the final output does not exist yet.
async function canonicalTarget(file) {
  try { return await realpath(file); }
  catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await canonicalTarget(parent), path.basename(file));
  }
}

async function residueCheck(component, root, files, traversalLimitations, context) {
  const findings = [], limitations = [...traversalLimitations];
  const add = (reason, file, message, evidence = {}) => findings.push({ ...issue(reason, file, message), severity: "medium", provenance: "unknown", ...evidence });
  for (const file of files) {
    if (residuePath(root, file)) add("residue_candidate", file, "Temporary, cached, output or state artifact may persist between sessions; verify ownership and cleanup.");
  }
  const targets = [];
  if (component.metadataError) limitations.push(issue("invalid_metadata", root, "Invalid Skill metadata prevents reliable declared-target inspection."));
  for (const access of ["read", "write"]) {
    for (const declaration of new Set(component[access === "read" ? "reads" : "writes"] ?? [])) {
      const file = declaredPath(declaration, root, context);
      if (!file) { limitations.push(issue("unresolved_declared_target", root, `Cannot resolve declared ${access} target: ${declaration}`)); continue; }
      try {
        const canonical = await canonicalTarget(file);
        let exists = false;
        let kind = null;
        try { const info = await stat(file); exists = true; kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "special"; }
        catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
        targets.push({ path: canonical, declaration, access, exists, kind, outsideSkill: !inside(root, canonical) });
      } catch { limitations.push(issue("unreadable_declared_target", file, "Cannot inspect declared target.")); }
    }
  }
  const writes = targets.filter((target) => target.access === "write");
  for (const target of targets) {
    if (target.access === "write" && target.outsideSkill) add("outside_skill_write", target.path, "Declared write escapes the Skill directory and may leave shared state for later sessions.", target);
    else if (target.access === "write" && target.exists) add("existing_write_target", target.path, "Declared output already exists and may contain prior-session data; verify ownership and cleanup.", target);
    const writable = writes.some((write) => write.path === target.path || write.kind === "directory" && inside(write.path, target.path));
    if (target.access === "read" && target.exists && (target.outsideSkill || writable || residuePath(root, target.path))) {
      add("persisted_state_read", target.path, "Existing shared or writable state is declared as input; verify provenance before later sessions reuse it.", target);
    }
  }
  return { ...result("cross_session_residue", files.length + targets.length, findings, limitations), scope: "skill-files-and-declared-targets" };
}

export async function auditSkill(component, { hashSource = pythonSourceHash, cwd = process.cwd(), home = os.homedir() } = {}) {
  if (!path.isAbsolute(component.source ?? "")) return Object.fromEntries(REQUIRED_CHECKS.map(({ id }) => [id, result(id, 0, [], [issue("source_unavailable", component.source, "The runtime did not provide a local Skill directory.")])]));
  const root = await realpath(component.source).catch(() => component.source);
  const { files, limitations } = await artifacts(root);
  const [pythonBytecode, crossSessionResidue] = await Promise.all([
    bytecodeCheck(root, files, limitations, hashSource),
    residueCheck(component, root, files, limitations, { cwd, home })
  ]);
  return { python_bytecode: pythonBytecode, cross_session_residue: crossSessionResidue };
}
