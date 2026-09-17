# OwnHow v0.7.0

OwnHow v0.7.0 improves runtime-aware Skill governance, execution traceability, and coordinated CLI + Skill updates.

## Highlights

- Added Skywork discovery and host-provided session manifests.
- Reduced cross-runtime duplicate findings and separated runtime copies, duplicate registrations, duplicate names, write collisions, and semantic overlap.
- Improved Chinese and English Skill resolution with aliases, keywords, field scoring, exclusion rules, and explicit augment contracts.
- Fixed false external-message risks for read-only review Skills.
- Added full YAML frontmatter parsing with nested metadata and clear parse errors.
- Added `doctor`, `methods`, and `rollback` commands.
- Added saved execution plans with task, runtime, digest, and Personal Method attribution.
- Added evidence labels for business, demo, and workflow-test outcomes.
- Added Personal Method version history and rollback support.
- Added `upgrade --check`, `upgrade --apply`, `upgrade --enable-auto`, `upgrade --auto`, and `upgrade --recover`.
- Added checksum verification, staged activation, transaction rollback, update locking, and optional Agent webhook notifications.
- Kept Plugin and standalone Skill workflows synchronized.

## Behavior changes

- Runtime selection is explicit unless `OWNHOW_RUNTIME` is set.
- `--runtime all` is reserved for cross-runtime comparison.
- Cached inventories must match the requested runtime.
- Similar Skills are not automatically added as augmentations.
- Text-only risk hints do not create approval requirements.
- Host-managed Plugin caches are not modified by the OwnHow updater.
- A successful update reports `sessionReloadRequired: true`; start a new Agent session before relying on the updated Skill.

## Validation

- 62 tests passed.
- Release bundle generation and checksum verification passed.
- Chinese and English resolver smoke checks passed.

## Upgrade

Existing v0.6.0 installations do not yet have `upgrade`. Bootstrap once:

```bash
npm install --global github:x2v-co/ownhow#v0.7.0
```

From v0.7.0 onward:

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

Plugin-managed installations should continue using their host Plugin manager.

Automatic mode accepts patch releases only. Push notifications require an operator-configured Agent gateway webhook; no remote Agent is enrolled automatically. See [Agent update setup](https://github.com/x2v-co/ownhow/blob/v0.7.0/docs/agent-updates.md).
