import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = "0.1";
const MODES = new Set(["off", "local", "remote"]);
const RUNTIMES = new Set(["codex", "hermes", "claude", "pi", "opencode", "openclaw", "skywork", "all", "unknown"]);
const EVENT_TYPES = new Set(["analyze", "resolve", "record", "doctor", "upgrade"]);

function telemetryDirectory(stateDir) { return path.join(stateDir, "telemetry"); }
function configFile(stateDir) { return path.join(telemetryDirectory(stateDir), "config.json"); }
function eventsFile(stateDir) { return path.join(telemetryDirectory(stateDir), "events.jsonl"); }

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function replaceText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
}

function defaultConfig() {
  return { schemaVersion: SCHEMA_VERSION, mode: "off", endpoint: null, agentId: null, consentAt: null, disabledAt: null };
}

function validateEndpoint(endpoint) {
  if (endpoint === null || endpoint === undefined || endpoint === "") return null;
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error("Telemetry endpoint must be a valid HTTPS URL."); }
  if (parsed.protocol !== "https:") throw new Error("Telemetry endpoint must use HTTPS.");
  if (parsed.username || parsed.password || parsed.hash || endpoint.includes("#")) throw new Error("Telemetry endpoint cannot contain credentials or fragments.");
  return parsed.toString();
}

export async function loadTelemetryConfig(stateDir) {
  const config = await readJson(configFile(stateDir), null);
  if (!config) return defaultConfig();
  if (config.schemaVersion !== SCHEMA_VERSION || !MODES.has(config.mode)) throw new Error("Invalid telemetry configuration.");
  return { ...defaultConfig(), ...config, endpoint: validateEndpoint(config.endpoint) };
}

export async function configureTelemetry(stateDir, { mode = "local", endpoint = null } = {}) {
  if (!MODES.has(mode) || mode === "off") throw new Error("Telemetry enable mode must be local or remote.");
  const safeEndpoint = mode === "remote" ? validateEndpoint(endpoint) : null;
  if (mode === "remote" && !safeEndpoint) throw new Error("Remote telemetry requires an HTTPS --endpoint.");
  const previous = await loadTelemetryConfig(stateDir);
  const config = {
    schemaVersion: SCHEMA_VERSION,
    mode,
    endpoint: safeEndpoint,
    agentId: mode === "remote" ? previous.agentId ?? `agent-${randomUUID()}` : null,
    consentAt: new Date().toISOString(),
    disabledAt: null
  };
  await writeJson(configFile(stateDir), config);
  return config;
}

export async function disableTelemetry(stateDir) {
  const previous = await loadTelemetryConfig(stateDir);
  const config = { ...previous, mode: "off", disabledAt: new Date().toISOString() };
  await writeJson(configFile(stateDir), config);
  return config;
}

function bucket(value, ranges = [50, 100, 250, 500, 1000, 2500, 5000]) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const upper = ranges.find((limit) => number <= limit);
  return upper ? `0-${upper}ms` : `${ranges.at(-1)}ms+`;
}

function countBucket(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  if (number === 0) return "0";
  if (number <= 10) return "1-10";
  if (number <= 50) return "11-50";
  if (number <= 100) return "51-100";
  if (number <= 500) return "101-500";
  return "500+";
}

function enumValue(value, allowed, fallback = null) { return allowed.has(value) ? value : fallback; }

// Only accept aggregate, enumerable fields. This function intentionally has no
// task/text/path fields, so callers cannot accidentally put sensitive content
// into the telemetry ledger.
export function sanitizeTelemetryEvent(event = {}) {
  const safe = {
    schemaVersion: SCHEMA_VERSION,
    id: `event-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    type: enumValue(event.type, EVENT_TYPES, "unknown"),
    runtime: enumValue(event.runtime, RUNTIMES, "unknown"),
    scope: enumValue(event.scope, new Set(["session-visible", "runtime-roots", "unknown"]), "unknown"),
    result: enumValue(event.result, new Set(["matched", "no_match", "success", "failure", "unknown"]), "unknown"),
    cache: enumValue(event.cache, new Set(["live", "cached", "fast", "unknown"]), "unknown"),
    latencyBucket: bucket(event.latencyMs),
    candidateCount: countBucket(event.candidateCount),
    skillCount: countBucket(event.skillCount),
    findingCount: countBucket(event.findingCount),
    actionableFindingCount: countBucket(event.actionableFindingCount),
    methodUsed: typeof event.methodUsed === "boolean" ? event.methodUsed : null,
    correctionProvided: typeof event.correctionProvided === "boolean" ? event.correctionProvided : null,
    verifiedBy: enumValue(event.verifiedBy, new Set(["user", "agent", "automated", "unknown"]), "unknown")
  };
  return Object.fromEntries(Object.entries(safe).filter(([, value]) => value !== null));
}

async function loadEvents(stateDir) {
  try {
    const text = await readFile(eventsFile(stateDir), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function recordTelemetryEvent(stateDir, event) {
  const config = await loadTelemetryConfig(stateDir);
  if (config.mode === "off") return { recorded: false, event: null };
  const safe = sanitizeTelemetryEvent(event);
  await mkdir(telemetryDirectory(stateDir), { recursive: true });
  await appendFile(eventsFile(stateDir), `${JSON.stringify(safe)}\n`, "utf8");
  return { recorded: true, event: safe };
}

export async function telemetryStatus(stateDir) {
  const config = await loadTelemetryConfig(stateDir);
  const events = await loadEvents(stateDir);
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: config.mode,
    endpoint: config.endpoint,
    consentAt: config.consentAt,
    disabledAt: config.disabledAt,
    events: events.length,
    pendingEvents: events.filter((event) => !event.sentAt).length,
    dataPolicy: "aggregate-only; task text, Skill bodies, paths, Receipts, corrections, and Personal Methods are excluded"
  };
}

export async function exportTelemetry(stateDir) { return loadEvents(stateDir); }

export async function purgeTelemetry(stateDir) {
  await rm(eventsFile(stateDir), { force: true });
  return telemetryStatus(stateDir);
}

export async function sendTelemetry(stateDir, fetchImpl = globalThis.fetch) {
  const config = await loadTelemetryConfig(stateDir);
  if (config.mode !== "remote" || !config.endpoint) throw new Error("Remote telemetry is not enabled.");
  if (typeof fetchImpl !== "function") throw new Error("This Node runtime does not provide fetch.");
  const events = await loadEvents(stateDir);
  const pending = events.filter((event) => !event.sentAt);
  if (!pending.length) return { sent: 0, pending: 0 };
  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ownhow-telemetry-schema": SCHEMA_VERSION },
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, agentId: config.agentId, events: pending })
  });
  if (!response.ok) throw new Error(`Telemetry server returned HTTP ${response.status}.`);
  const sentAt = new Date().toISOString();
  const updated = events.map((event) => pending.includes(event) ? { ...event, sentAt } : event);
  await replaceText(eventsFile(stateDir), `${updated.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { sent: pending.length, pending: 0 };
}
