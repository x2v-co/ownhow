import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

export const REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ id: "python_bytecode", name: "Stale/mismatched Python bytecode", required: true, reference: "https://arxiv.org/abs/2610.10612" })
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
  return match ? path.join(path.dirname(directory), `${match[1]}.py`) : null;
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
    if (!source) { limitations.push(issue("unknown_source_mapping", file, "Cannot map this cache filename to Python source.")); continue; }
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

export async function auditSkill(component, { hashSource = pythonSourceHash } = {}) {
  if (!path.isAbsolute(component.source ?? "")) return Object.fromEntries(REQUIRED_CHECKS.map(({ id }) => [id, result(id, 0, [], [issue("source_unavailable", component.source, "The runtime did not provide a local Skill directory.")])]));
  const root = await realpath(component.source).catch(() => component.source);
  const { files, limitations } = await artifacts(root);
  return { python_bytecode: await bytecodeCheck(root, files, limitations, hashSource) };
}
