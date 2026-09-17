# CLI and Skill updates

The updater downloads a matching CLI and standalone Skill from the official
`x2v-co/ownhow` GitHub Release. It stages files, checks SHA-256 integrity, runs
`doctor` and Chinese/English `resolve` smoke checks, activates both destinations,
and runs the checks again. Failure restores both previous destinations.
Personal Methods, receipts, and configuration remain outside the installation.

v0.7.0 publishes the updater and matching release assets. Existing v0.6.0 installations need one normal CLI upgrade to acquire the updater. Releases before v0.7.0 do not contain the manifest/bundle assets.

## One-time enrollment

For an npm global installation, the existing package directory is detected. For
another layout, supply its real package directory explicitly. The updater
refuses source checkouts, directory symlinks, and known host-managed Plugin
caches. Prefer a dedicated standalone destination when enrolling a new Agent:

```bash
ownhow upgrade --check --json
ownhow upgrade --apply \
  --install-dir "$HOME/.local/share/ownhow" \
  --skill-dir "$HOME/.hermes/skills/ownhow-governance" --json
```

A new installation does not change PATH. Invoke its returned `cliPath` with Node
or point your CLI launcher at it. Updating an existing npm package retains the
existing `ownhow` launcher. With a new Skill directory, register it using the
host's documented mechanism. Do not install another standalone copy when the
Agent already uses the OwnHow Plugin; update that Plugin through its host.

If `--skill-dir` is omitted, the CLI's bundled Skill is updated and the response
reports `skillDelivery: bundled-only` and `pluginUpdateRequired: true`. That is
not confirmation that any installed Plugin has changed. This first updater does
not drive proprietary Plugin managers or modify their caches.

```bash
ownhow upgrade --enable-auto \
  --install-dir "$HOME/.local/share/ownhow" \
  --skill-dir "$HOME/.hermes/skills/ownhow-governance" --json
```

Enrollment stores local policy under `~/.ownhow/updates/config.json`. Automatic
updates permit stable patch versions only. A minor/major update returns
`approval_required`; explicitly invoke `--apply` for a reviewed update.
`ownhow upgrade --disable-auto` disables policy. Nothing installs a daemon or
registers a remote subscriber automatically.

## Agent task-start hook

Have the host invoke this at task boundaries, before starting work:

```bash
ownhow upgrade --auto --json
```

The enabled policy is checked at most once per 24 hours after a successful
check/update. Failed downloads are retryable. Start a new session when
`sessionReloadRequired` is true. `sessionLoadedVersion: unknown` is deliberate:
OwnHow cannot verify which Skill body the host has already put in context.
Running an updater midway through a task does not update that context.

## Push from a release to Agents

The release workflow publishes three assets under a matching `vX.Y.Z` tag:

- `ownhow-update.json`: stable version and bundle SHA-256.
- `ownhow-bundle.json`: CLI and standalone Skill, same version.
- `ownhow-update-notice.txt`: `ownhow:update:v1:X.Y.Z`.

Configure repository secrets `OWNHOW_UPDATE_WEBHOOK` (HTTPS Agent gateway URL)
and optionally `OWNHOW_UPDATE_WEBHOOK_TOKEN` (Bearer credential). On release,
the workflow posts:

```json
{"event":"ownhow.release","version":"0.6.1","notice":"ownhow:update:v1:0.6.1","releaseUrl":"https://github.com/x2v-co/ownhow/releases/tag/v0.6.1"}
```

Your gateway routes the notice to enrolled Agents. Queue it until each Agent's
next task boundary, then call the CLI with argument arrays, never shell
interpolation:

```js
execFile("ownhow", ["upgrade", "--auto", "--notice", event.notice, "--json"]);
```

A valid notice bypasses daily throttling. It selects only a stable version from
the fixed official GitHub release path; it cannot provide a download URL or
shell script. Enrollment still applies. Duplicate delivery is safe: the same
installed version returns `up_to_date`. Treat webhook success only as delivery,
not proof that an Agent updated; collect the returned JSON at your gateway.
Absent webhook secrets, the workflow skips sending and leaves the notice asset
available. Failed delivery fails the notification step; rerun that step or send
the same notice through the existing gateway. No remote Agent is enrolled or
messaged just by building this code.

## Failure recovery and limitations

The update journal is `~/.ownhow/updates/transaction.json`. A subsequent mutating
updater restores an unfinished transaction before attempting another update.
After confirming a crashed updater is stopped, remove its `updates/lock`
directory and run `ownhow upgrade --recover`. A live updater's lock must not be
removed. Successful updates retain backup directories beside each destination;
paths are returned in JSON. Use one state directory per installation, and
serialize invocations at the Agent gateway.

The official GitHub release channel is the trust boundary. SHA-256 detects a
changed download, not compromise of the publisher account. No archive paths,
install scripts, or pushed shell commands are executed during extraction; the
verified CLI itself runs for smoke checks. These checks prove installation and
selection work, not improved business outcomes.
