import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const PERMISSION_CHECK_IDS = Object.freeze(["self_log_tampering", "external_network_access", "cross_agent_communication"]);
const MODES = new Set(["off", "warn", "block"]);
const MAX_BYTES = 1024 * 1024;
const inside = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
const limitation = (reason, file, message) => ({ reason, path: file, message });

// Policy is evaluated separately from detection, including for cached evidence.
export function permissionPolicy({ mode = process.env.OWNHOW_PERMISSION_CHECKS ?? "warn", overrides = [], allowSkills = [] } = {}) {
  const modes = Object.fromEntries(PERMISSION_CHECK_IDS.map((id) => [id, "warn"]));
  const assign = (entry) => {
    const match = String(entry).match(/^([^=]+)=(off|warn|block)$/);
    if (!match || !PERMISSION_CHECK_IDS.includes(match[1])) throw new Error(`Invalid permission check policy: ${entry}`);
    modes[match[1]] = match[2];
  };
  if (MODES.has(mode)) for (const id of PERMISSION_CHECK_IDS) modes[id] = mode;
  else for (const entry of String(mode).split(",")) assign(entry.trim());
  for (const entry of overrides) assign(entry);
  if (!Array.isArray(allowSkills) || allowSkills.some((id) => typeof id !== "string" || !id)) throw new Error("Permission allowlist requires exact Skill IDs.");
  return { modes, allowSkills };
}

function isManifest(file) {
  return /(?:^|[/\\])(?:plugin\.json|package\.json|\.mcp\.json|(?:opencode|openclaw)(?:\.config)?\.(?:json[5c]?|ya?ml)|openclaw\.plugin\.json)$/.test(file)
    || /[/\\]\.(?:claude|codex)-plugin[/\\]/.test(file);
}
function candidate(file) {
  return isManifest(file) || /\.(?:md|sh|bash|zsh|fish|py|pyw|js|mjs|cjs|jsx|ts|tsx|rb|ps1|psm1|pl|php|go|rs|lua|cmd|bat)$/i.test(file) || !path.extname(file);
}

// Read at most the cap plus one byte, even when a file grows during inspection.
// O_NOFOLLOW prevents a final-path symlink swap from being followed.
async function boundedText(file, limitations) {
  let handle;
  try {
    if (!(await lstat(file)).isFile()) { limitations.push(limitation("uninspected_special_file", file, "Permission inspection does not follow symlinks or special files.")); return null; }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0) || bytes.subarray(0, 8192).some((byte) => byte < 9 || byte > 13 && byte < 32)) return null;
    if (length > MAX_BYTES) { limitations.push(limitation("permission_file_size_limit", file, "Permission inspection is limited to 1 MiB per text file; this file was not inspected.")); return null; }
    return bytes.toString("utf8");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") limitations.push(limitation("unreadable_permission_file", file, "Cannot read permission inspection input."));
    return null;
  } finally { await handle?.close(); }
}

// Only known manifests are read from ancestors. Never walk the user's home or
// workspace to discover a package, and never follow manifest symlinks.
async function associatedManifests(component, root, limitations, traverse) {
  let directory = component.pluginRoot ?? root;
  for (let depth = 0; depth <= 32; depth++) {
    const names = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json", "package.json", "openclaw.plugin.json", "opencode.json", "opencode.jsonc", "openclaw.json", "openclaw.json5"];
    const texts = new Map();
    let associated = false;
    for (const name of names) {
      if (name.includes("/")) {
        const parent = path.join(directory, path.dirname(name));
        if ((await lstat(parent).catch(() => null))?.isSymbolicLink()) {
          limitations.push(limitation("uninspected_special_file", parent, "Permission inspection does not follow manifest directory symlinks."));
          continue;
        }
      }
      const file = path.join(directory, name);
      const before = limitations.length;
      const text = await boundedText(file, limitations);
      if (text !== null) {
        texts.set(file, text);
        if (name !== "package.json" || component.pluginRoot === directory) associated = true;
        else {
          // A parent package is relevant only when its declared Skill paths
          // actually contain this Skill (fixtures/other packages are siblings).
          try {
            const manifest = JSON.parse(text);
            const declarations = manifest.pi?.skills ?? manifest.openclaw?.skills ?? manifest.opencode?.skills ?? [];
            if (Array.isArray(declarations) && declarations.some((value) => typeof value === "string" && !value.startsWith("!") && inside(path.resolve(directory, value.replace(/[*?].*$/, "")), root))) associated = true;
          } catch { /* Invalid metadata inside the Skill is still inspected. */ }
        }
      } else if (limitations.length > before) associated = true;
    }
    if (associated) {
      for (const name of [".mcp.json", "opencode.yaml", "opencode.yml", "openclaw.yaml", "openclaw.yml"]) {
        const file = path.join(directory, name), text = await boundedText(file, limitations);
        if (text !== null) texts.set(file, text);
      }
      for (const name of [".claude-plugin", ".codex-plugin"]) {
        const folder = path.join(directory, name);
        if (!(await lstat(folder).catch(() => null))?.isDirectory()) continue;
        const artifacts = await traverse(folder);
        limitations.push(...artifacts.limitations);
        for (const file of artifacts.files) if (!texts.has(file)) {
          const text = await boundedText(file, limitations);
          if (text !== null) texts.set(file, text);
        }
      }
      return texts;
    }
    const parent = path.dirname(directory);
    if (parent === directory || component.pluginRoot) break;
    directory = parent;
  }
  return new Map();
}

const LOG_PATH = /log|audit|receipt|transcript|history|\.jsonl\b/i;
const MUTATE = /\b(?:rm|cp|mv|mkdir|install|tee|touch|rename(?:Sync)?|write|writelines|ftruncate|Copy-Item|Move-Item|New-Item|Add-Content|truncate|unlink(?:Sync)?|writeFile(?:Sync)?|appendFile(?:Sync)?|remove|rmtree|DeleteFile|Remove-Item|Set-Content|Clear-Content|write_text|write_bytes)\b|\bsed\b[^\n]*\s-i\b|\bopen\s*\([^\n]*[,=]\s*['"](?:[wax][b+t]*|[brt]*\+)[^'"]*['"]|(?:^|[^<])>{1,2}\s*[^\s]/i;
const NETWORK = /(?:^|[\/\s;|&('"`=])(?:curl|wget|nc|ncat|netcat|ssh|scp)(?=[\s('"`)]|$)|\bfetch\s*\(|\baxios\b|\b(?:requests|urllib|httpx|aiohttp|http\.client)\s*\.|\b(?:import|from)\s+(?:requests|urllib|httpx|aiohttp|http\.client)\b|["']net\/http["']|\bWeb(?:Fetch|Search)\b/i;
const AGENT = /\b(?:SendToAgent|send_message|spawn_agent|spawn_subagent|subagents?)\b|\bspawn\s+(?:a\s+)?sub[- ]agents?\b|\bclaude\s+[^\n]*?(?:-p\b|--print\b)|\bcodex\s+exec\b|\bopencode\s+run\b|(?:^|[\s;|&('"`=])(?:pi|hermes)(?=\s+[^:"\s]|$)|\b(?:Task|Agent)\s+tools?\b|\bA2A\b|agent[-_ ]card|\/\.well-known\/agent\.json/i;
const AGENT_TOOL = /\b(?:Task|Agent|SendToAgent|send_message|spawn_agent|spawn_subagent|subagent)\b/i;
const EXPLANATIONS = {
  self_log_tampering: "Writing or erasing logs, audit trails, receipts or history can hide actions from oversight.",
  external_network_access: "External network access enables data exfiltration or unauthorized access to remote systems.",
  cross_agent_communication: "Communication or shared writes between agents can enable collusion beyond the user's oversight."
};
function otherAgentPath(text, root, { home, cwd }) {
  const paths = (text.match(/[~$\w{}./-]+/g) ?? []).filter((value) =>
    /(?:^|\/)(?:\.(?:claude|codex|hermes|pi|openclaw)|\.config\/opencode|agents)(?:\/|$)/.test(value));
  return paths.some((value) => {
    const target = value.replace(/^~(?=\/)|^\$\{?HOME\}?/, home).replace(/^\$\{?(?:WORKSPACE|CWD)\}?/, cwd);
    return !inside(root, path.resolve(root, target));
  });
}

export async function permissionChecks(component, root, files, traversalLimitations, context, traverse) {
  const limitations = [...traversalLimitations];
  const texts = new Map();
  for (const file of files.filter(candidate)) {
    const text = await boundedText(file, limitations);
    if (text !== null && (path.extname(file) || text.startsWith("#!"))) texts.set(file, text);
  }
  const related = await associatedManifests(component, root, limitations, traverse);
  for (const [file, text] of related) if (!texts.has(file)) texts.set(file, text);
  if (component.metadataError) limitations.push(limitation("invalid_metadata", path.join(root, "SKILL.md"), "Invalid metadata may hide permission declarations."));
  const findings = Object.fromEntries(PERMISSION_CHECK_IDS.map((id) => [id, []]));
  const add = (id, reason, file, line, evidence, risk) => findings[id].push({ severity: risk === "low" ? "info" : risk, risk, reason, path: file, line, evidence: evidence.trim().slice(0, 200), message: EXPLANATIONS[id] });
  for (const [file, text] of texts) {
    const markdown = /\.md$/i.test(file);
    // Package repository/bug links are metadata, not remote MCP servers.
    let packageServerUrls = null;
    if (path.basename(file) === "package.json") {
      packageServerUrls = [];
      try {
        const collect = (value, server = false) => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "url" && server && typeof child === "string") packageServerUrls.push(child);
            collect(child, server || /mcp|servers?|remote/i.test(key));
          }
        };
        collect(JSON.parse(text));
      } catch {
        limitations.push(limitation("invalid_permission_manifest", file, "Invalid package manifest prevents reliable remote-server URL inspection."));
      }
    }
    let frontmatter = false, fence = false, field = "";
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (markdown && (index === 0 || frontmatter) && /^---\s*$/.test(line)) { frontmatter = !frontmatter; field = ""; continue; }
      if (markdown && /^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      const key = line.match(/^\s*["']?([\w-]+)["']?\s*:/)?.[1];
      if (key) field = key;
      const declared = !markdown || frontmatter;
      const writes = declared && (field === "writes" || /["']?writes["']?\s*:/.test(line));
      const tools = declared && (/^(?:allowed-tools|tools)$/.test(field) || /["']?(?:allowed-tools|tools)["']?\s*:/.test(line));
      const effects = declared && (/^(?:side_effects|sideEffects)$/.test(field) || /["']?(?:side_effects|sideEffects)["']?\s*:/.test(line));
      const remoteUrl = isManifest(file) && /["']?url["']?\s*:\s*["']?https?:\/\//i.test(line)
        && (packageServerUrls === null || packageServerUrls.some((url) => line.includes(url)));
      const comment = !markdown && /^\s*(?:#|\/\/|\/\*|\*)/.test(line);
      const risk = markdown && !frontmatter && !fence || comment ? "low" : markdown && fence ? "medium" : "high";
      if (LOG_PATH.test(line) && (writes || MUTATE.test(line)) || /\bhistory\s+-c\b|\bgit\s+commit\b[^\n]*--amend\b|\bgit\s+reflog\s+expire\b/i.test(line)) add("self_log_tampering", writes ? "declared_log_write" : "log_mutation", file, index + 1, line, risk);
      if (NETWORK.test(line) || effects && /network|https?|internet/i.test(line) || remoteUrl) add("external_network_access", remoteUrl ? "remote_server_url" : effects ? "declared_network_effect" : tools ? "declared_network_tool" : "network_access", file, index + 1, line, risk);
      if (AGENT.test(line) || tools && AGENT_TOOL.test(line) || (writes || MUTATE.test(line)) && otherAgentPath(line, root, context)) add("cross_agent_communication", writes ? "declared_agent_write" : tools ? "declared_agent_tool" : "agent_communication", file, index + 1, line, risk);
    }
  }
  // Runtime projections can supply declarations that have no local metadata.
  for (const [field, values] of [["writes", component.writes], ["tools", component.tools], ["sideEffects", component.sideEffects]]) {
    for (const value of values ?? []) {
      if ([...texts.values()].some((text) => text.includes(value))) continue;
      const file = path.join(root, "SKILL.md"), evidence = `${field}: ${value}`;
      if (field === "writes" && LOG_PATH.test(value)) add("self_log_tampering", "declared_log_write", file, 1, evidence, "high");
      if (field === "tools" && NETWORK.test(value) || field === "sideEffects" && /network|internet|http/i.test(value)) add("external_network_access", "declared_network_capability", file, 1, evidence, "high");
      if (field === "tools" && AGENT_TOOL.test(value) || field === "writes" && otherAgentPath(value, root, context)) add("cross_agent_communication", "declared_agent_capability", file, 1, evidence, "high");
    }
  }
  return Object.fromEntries(PERMISSION_CHECK_IDS.map((id) => [id, { id, required: true, mode: "warn", status: findings[id].length ? "findings" : limitations.length ? "unknown" : "pass", inspected: texts.size, findings: findings[id], limitations: [...limitations] }]));
}
