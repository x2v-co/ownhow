# OwnHow v0.10.0

OwnHow v0.10.0 is the first publish of package `ownhow` on the public npm
registry. Telemetry stays off unless someone opts in. The GitHub Release and
update bundle are unchanged.

## Highlights

- A `vX.Y.Z` tag runs `npm run verify`, then `npm publish --provenance --access public`.
  The repository secret `NPM_TOKEN` is required for this first publish.
  See [CLI and Skill updates](agent-updates.md#npm-registry).
- Local internal-beta telemetry can record `slim`, `propose`, and `apply`
  events. `telemetry enable --mode local --cohort ID` stores a local cohort
  label, and `telemetry export --by-day` groups the ledger by UTC date.
  Remote mode still needs an explicit HTTPS endpoint and `telemetry send`,
  and it does not send the cohort. See [telemetry](telemetry.md).
- `ownhow slim` reviews unused, overlapping, and oversized Skills and applies
  an explicit allowlist without deleting files. See [slimming](slimming.md).
- `analyze` reports `self_log_tampering`, `external_network_access`, and
  `cross_agent_communication`. These permission checks default to `warn` and
  do not change approvals. See [audit checks](audit-checks.md).

## Behavior changes

- Telemetry remains disabled by default. `--cohort` is accepted only in local mode.
- Install this CLI from npm. Plugin and standalone Skill installs still use the `v0.10.0` git tag.
- Enrolled patch auto-update treats 0.10.0 as a minor release and returns `approval_required` until it is applied explicitly.

## Validation

- `npm run verify`: 133 tests passed.
- `npm pack --dry-run` includes `src/cli.js`, `src/telemetry.js`, and `docs/telemetry.md`.

## Upgrade

```sh
npm install --global ownhow@0.10.0
```
