import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  configureTelemetry,
  disableTelemetry,
  exportTelemetry,
  purgeTelemetry,
  recordTelemetryEvent,
  sendTelemetry,
  telemetryStatus
} from "../src/telemetry.js";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function temporaryState() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ownhow-telemetry-test-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("telemetry is off by default and records nothing", async () => {
  const state = await temporaryState();
  try {
    assert.equal((await telemetryStatus(state.directory)).mode, "off");
    assert.equal((await recordTelemetryEvent(state.directory, { type: "analyze", runtime: "codex" })).recorded, false);
    assert.deepEqual(await exportTelemetry(state.directory), []);
  } finally { await state.cleanup(); }
});

test("local telemetry stores aggregate fields and excludes sensitive input", async () => {
  const state = await temporaryState();
  try {
    await configureTelemetry(state.directory);
    const result = await recordTelemetryEvent(state.directory, {
      type: "resolve", runtime: "codex", scope: "runtime-roots", result: "matched", latencyMs: 42,
      candidateCount: 11, skillCount: 4, task: "private customer task", path: "/Users/private/project",
      receipt: "private receipt", correction: "private correction", skillBody: "secret skill"
    });
    assert.equal(result.recorded, true);
    const [event] = await exportTelemetry(state.directory);
    assert.equal(event.type, "resolve");
    assert.equal(event.candidateCount, "11-50");
    assert.equal(event.latencyBucket, "0-50ms");
    assert.equal("task" in event, false);
    assert.equal("path" in event, false);
    assert.equal("receipt" in event, false);
    assert.equal("correction" in event, false);
    assert.equal("skillBody" in event, false);
  } finally { await state.cleanup(); }
});

test("remote telemetry requires a credential-free HTTPS endpoint", async () => {
  const state = await temporaryState();
  try {
    await assert.rejects(configureTelemetry(state.directory, { mode: "remote", endpoint: "http://example.test/telemetry" }), /HTTPS/);
    await assert.rejects(configureTelemetry(state.directory, { mode: "remote", endpoint: "https://user:pass@example.test/telemetry" }), /credentials/);
    await assert.rejects(configureTelemetry(state.directory, { mode: "remote", endpoint: "https://example.test/telemetry#events" }), /fragments/);
    const config = await configureTelemetry(state.directory, { mode: "remote", endpoint: "https://example.test/telemetry" });
    assert.equal(config.mode, "remote");
    assert.match(config.agentId, /^agent-/);
  } finally { await state.cleanup(); }
});

test("disable stops collection and purge removes the local ledger", async () => {
  const state = await temporaryState();
  try {
    await configureTelemetry(state.directory);
    await recordTelemetryEvent(state.directory, { type: "doctor", runtime: "pi", result: "success" });
    await disableTelemetry(state.directory);
    assert.equal((await recordTelemetryEvent(state.directory, { type: "doctor", runtime: "pi" })).recorded, false);
    assert.equal((await telemetryStatus(state.directory)).events, 1);
    assert.equal((await purgeTelemetry(state.directory)).events, 0);
  } finally { await state.cleanup(); }
});

test("send posts only pending events and marks them after a successful response", async () => {
  const state = await temporaryState();
  try {
    await configureTelemetry(state.directory, { mode: "remote", endpoint: "https://example.test/telemetry" });
    await recordTelemetryEvent(state.directory, { type: "analyze", runtime: "hermes", task: "do not send" });
    let request;
    const sent = await sendTelemetry(state.directory, async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, status: 202 };
    });
    assert.equal(sent.sent, 1);
    assert.equal(request.events.length, 1);
    assert.equal("task" in request.events[0], false);
    assert.equal((await telemetryStatus(state.directory)).pendingEvents, 0);
  } finally { await state.cleanup(); }
});

test("failed remote delivery leaves events pending", async () => {
  const state = await temporaryState();
  try {
    await configureTelemetry(state.directory, { mode: "remote", endpoint: "https://example.test/telemetry" });
    await recordTelemetryEvent(state.directory, { type: "upgrade", result: "success" });
    await assert.rejects(sendTelemetry(state.directory, async () => ({ ok: false, status: 503 })), /HTTP 503/);
    assert.equal((await telemetryStatus(state.directory)).pendingEvents, 1);
  } finally { await state.cleanup(); }
});

test("CLI telemetry opt-in records aggregate analyze usage", async () => {
  const state = await temporaryState();
  try {
    const cli = path.join(root, "src", "cli.js");
    const fixtureRoot = path.join(root, "test", "fixtures", "home", ".agents", "skills");
    await exec(process.execPath, [cli, "telemetry", "enable", "--mode", "local", "--state", state.directory]);
    await exec(process.execPath, [cli, "analyze", "--runtime", "claude", "--root", fixtureRoot, "--state", state.directory, "--json"]);
    const result = await exec(process.execPath, [cli, "telemetry", "status", "--state", state.directory, "--json"]);
    const status = JSON.parse(result.stdout);
    assert.equal(status.mode, "local");
    assert.equal(status.events, 1);
  } finally { await state.cleanup(); }
});

test("telemetry failures do not block the primary CLI command", async () => {
  const state = await temporaryState();
  try {
    await mkdir(path.join(state.directory, "telemetry"), { recursive: true });
    await writeFile(path.join(state.directory, "telemetry", "config.json"), JSON.stringify({ schemaVersion: "invalid", mode: "remote" }));
    const cli = path.join(root, "src", "cli.js");
    const fixtureRoot = path.join(root, "test", "fixtures", "home", ".agents", "skills");
    const result = await exec(process.execPath, [cli, "analyze", "--runtime", "claude", "--root", fixtureRoot, "--state", state.directory, "--json"]);
    assert.equal(JSON.parse(result.stdout).coverage.totalSkills, 1);
  } finally { await state.cleanup(); }
});
