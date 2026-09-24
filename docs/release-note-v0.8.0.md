# OwnHow v0.8.0

OwnHow v0.8.0 makes Skill governance observable across runtime discovery,
session visibility, actual usage, structured feedback, and coordinated updates.

## Highlights

- Added explicit Skill lifecycle states: `discovered`, `installed`, `enabled`,
  `sessionVisible`, and `actualUsed`.
- Added Session Manifest v1 for host-reported Skills, Plugins, active Skills,
  and optional actual-use evidence, while retaining the legacy manifest format.
- Added structured governance fields to Receipts and Receipt Bundle v2,
  including `actualUsed`, with explicit pending Inbox acceptance for remote
  feedback.
- Added aggregate opt-in telemetry with local and HTTPS remote modes. Task text,
  Skill content, Receipts, paths, and Personal Methods are excluded.
- Reduced duplicate filesystem scans and analyzer noise through shared scan
  caches, canonical root deduplication, selective token indexes, and grouped
  informational findings.
- Added fast snapshot reuse and gstack-style update prompts with bounded
  snoozing for unenrolled Agents.
- Kept the Codex Plugin, Claude Plugin, standalone Skill, CLI, and release
  bundle on one version and synchronized the governance workflow.

## Behavior changes

- A discovered Skill is not treated as installed, enabled, session-visible, or
  actually used. Unknown lifecycle fields remain unknown.
- Hosts can provide `actualUsedSkillNames` only when the list is exhaustive for
  the observed session or task. Otherwise the field remains unknown.
- `ownhow record --governance '<json>'` accepts typed boolean or null evidence;
  unknown claims must remain `null`.
- Receipt Bundle v2 carries optional governance evidence. v1 remains compatible
  and intentionally minimal.
- Telemetry is disabled by default and cannot act as a remote-control channel.
- Host-managed Plugin caches are not modified by the OwnHow updater.

## Validation

- `npm run verify`: 87 tests passed.
- `git diff --check`: passed.
- Release bundle generation, schema validation, and SHA-256 verification passed.
- `npm pack --dry-run`: passed with the new session manifest, telemetry, and
  governance documentation included.

## Upgrade

Existing v0.7.0 installations can run:

```bash
ownhow upgrade --check --json
ownhow upgrade --apply --json
```

For opt-in automatic patch updates:

```bash
ownhow upgrade --enable-auto \
  --install-dir <cli-install-dir> \
  --skill-dir <standalone-skill-dir>
ownhow upgrade --auto --json
```

Plugin-managed installations should update through their host Plugin manager.
Start a new Agent session after an update when `sessionReloadRequired` is true.
