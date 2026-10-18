# Changelog

Release notes for each version live in `docs/release-note-v<version>.md`.

## 0.10.0 — 2026-10-18

- Publish package `ownhow` to the public npm registry from a `vX.Y.Z` tag. See [docs/release-note-v0.10.0.md](docs/release-note-v0.10.0.md).
- Local internal-beta telemetry, still off by default: `slim`, `propose`, and `apply` events; `telemetry enable --mode local --cohort ID`; `telemetry export --by-day`. See [docs/telemetry.md](docs/telemetry.md).
- Skill-library slimming and explicit per-runtime allowlists. See [docs/slimming.md](docs/slimming.md).
- Permission checks `self_log_tampering`, `external_network_access`, and `cross_agent_communication`, defaulting to `warn`. See [docs/audit-checks.md](docs/audit-checks.md).

## 0.9.0 — 2026-10-15

- Mandatory `python_bytecode` and `cross_session_residue` checks in `analyze` (#2).
- CI: `npm ci --ignore-scripts` (#1).
- Metadata homepage points to GitHub.

## 0.8.0 — 2026-09-24

See [docs/release-note-v0.8.0.md](docs/release-note-v0.8.0.md).
