import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { aggregateTelemetryByDay, configureTelemetry, exportTelemetry, recordTelemetryEvent } from "../src/telemetry.js";

const exec = promisify(execFile);
const cli = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "src", "cli.js");

async function tempState() { return mkdtemp(path.join(os.tmpdir(), "ownhow-telemetry-day-")); }
function run(state, args, now) {
  return exec(process.execPath, [cli, ...args, "--state", state], { env: { ...process.env, OWNHOW_TELEMETRY_NOW: now ?? "" } }).catch((error) => error);
}

test("export --by-day shows 3 distinct dates with commands (fake clock)", async () => {
  const state = await tempState();
  try {
    await configureTelemetry(state, { mode: "local", cohort: "beta-01" });
    await recordTelemetryEvent(state, { type: "slim", result: "success" }, { now: new Date("2026-10-14T09:00:00Z") });
    await recordTelemetryEvent(state, { type: "propose", result: "success" }, { now: new Date("2026-10-15T09:00:00Z") });
    await recordTelemetryEvent(state, { type: "slim", result: "success" }, { now: new Date("2026-10-15T10:00:00Z") });
    await recordTelemetryEvent(state, { type: "apply", result: "success" }, { now: new Date("2026-10-16T09:00:00Z") });
    const days = await exportTelemetry(state, { byDay: true });
    assert.deepEqual(days.map((day) => day.date), ["2026-10-14", "2026-10-15", "2026-10-16"]);
    assert.deepEqual(days[1].commands, { propose: 1, slim: 1 });
    assert.deepEqual(days[2].commands, { apply: 1 });
    assert.ok(days.every((day) => day.cohorts.join() === "beta-01"));
    const raw = await exportTelemetry(state);
    assert.ok(raw.every((event) => event.cohort === "beta-01"));
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("CLI records slim/propose/apply events with cohort and aggregates by day", async () => {
  const state = await tempState();
  try {
    await run(state, ["telemetry", "enable", "--mode", "local", "--cohort", "c7"]);
    await run(state, ["slim", "list", "--json"], "2026-10-01T12:00:00Z");
    await run(state, ["propose", "--json"], "2026-10-02T12:00:00Z"); // fails: no receipts, still recorded as failure
    await run(state, ["apply", "missing", "--json"], "2026-10-03T12:00:00Z");
    const { stdout } = await exec(process.execPath, [cli, "telemetry", "export", "--by-day", "--state", state, "--json"]);
    const days = JSON.parse(stdout);
    assert.deepEqual(days.map((day) => [day.date, Object.keys(day.commands)]), [
      ["2026-10-01", ["slim"]], ["2026-10-02", ["propose"]], ["2026-10-03", ["apply"]]
    ]);
    assert.ok(days.every((day) => day.cohorts.join() === "c7"));
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("telemetry off records nothing for slim; cohort is local-only and validated", async () => {
  const state = await tempState();
  try {
    await run(state, ["slim", "list", "--json"]);
    assert.deepEqual(await exportTelemetry(state), []);
    await assert.rejects(configureTelemetry(state, { mode: "local", cohort: "bad id/../" }), /cohort/);
    await assert.rejects(configureTelemetry(state, { mode: "remote", endpoint: "https://example.test/t", cohort: "c1" }), /local/);
    assert.equal(aggregateTelemetryByDay([]).length, 0);
  } finally { await rm(state, { recursive: true, force: true }); }
});
