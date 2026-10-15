# OwnHow MVP

OwnHow is a local-first prototype for owning and improving how AI completes work. The MVP inventories Codex, Hermes, Claude Code, Pi, OpenCode, OpenClaw, and Skywork methods with explicit discovery and visibility states, explains conflicts and task selection, records evidence-backed outcomes, and turns explicit user corrections into Personal Method overlays.

Governance commands do not upload source files, call a model, or modify installed Plugins and Skills. The explicit updater can replace the selected OwnHow CLI and standalone OwnHow Skill.

## Requirements

- Node.js 22 or newer
- Local `python3` with a matching bytecode version for PEP 552 source-hash verification. Other checks work without Python; unavailable hash verification is reported as `unknown`.

## Install

Install the CLI directly from this repository:

```bash
npm install --global github:x2v-co/ownhow#v0.9.0
ownhow --help
```

Add the OwnHow marketplace and install the Codex Plugin (optional):

```bash
codex plugin marketplace add x2v-co/ownhow --ref v0.9.0
codex plugin add ownhow@x2v
```

Start a new Codex chat after installing the Plugin. The Plugin provides the governance workflow; the `ownhow` CLI performs local scanning and stores approved personal state.

### Hermes

Install the standalone Hermes Skill into the active Hermes profile:

```bash
hermes skills install https://raw.githubusercontent.com/x2v-co/ownhow/v0.9.0/skills/ownhow-governance/SKILL.md --yes
```

The CLI discovers active Hermes skills under `~/.hermes/skills` automatically, following Hermes' archive, support-directory, platform, environment, disabled-skill, symlink, and duplicate-name discovery rules. Use `--runtime hermes` to keep analysis scoped to Hermes, or `--root PATH` for a custom `HERMES_HOME`/profile.

### Claude Code

Add the OwnHow marketplace and install the Claude Code Plugin:

```bash
claude plugin marketplace add x2v-co/ownhow
claude plugin install ownhow@x2v --scope user
```

Start a new Claude Code session after installation. OwnHow follows Claude Code's active discovery state: personal and project Skills, directory symlinks, `skillOverrides: off`, enabled skills-directory Plugins, and the selected installed version of marketplace Plugins. Plugin Skills retain Claude Code's `plugin:skill` namespace. Use `--runtime claude` to scope analysis to Claude Code.

The static inventory includes project Skills active at session startup. Claude Code can add nested `.claude/skills` later when a session first reads or edits files under that directory; a future session-aware adapter will model those dynamic additions.

### Pi

Install OwnHow as a Pi Package:

```bash
pi install git:github.com/x2v-co/ownhow@v0.9.0
```

OwnHow follows Pi's project trust gate, project-over-user precedence, `.pi` and `.agents` discovery, settings filters, symlink deduplication, and Package-contributed Skills. Use `--runtime pi` for Pi-only analysis.

### OpenCode

Install the standalone Skill in OpenCode's global Skill directory:

```bash
git clone --branch v0.9.0 --depth 1 https://github.com/x2v-co/ownhow.git ~/.local/share/ownhow
ln -s ~/.local/share/ownhow/skills/ownhow-governance ~/.config/opencode/skills/ownhow-governance
```

OwnHow uses `opencode debug skill` as the authoritative live inventory when OpenCode is available, including external compatibility Skills, configured paths, remote Skills, and duplicate-name resolution. Use `--runtime opencode` for OpenCode-only analysis.

### OpenClaw

Install the standalone Skill globally:

```bash
git clone --branch v0.9.0 --depth 1 https://github.com/x2v-co/ownhow.git ~/.local/share/ownhow
openclaw skills install ~/.local/share/ownhow/skills/ownhow-governance --global --as ownhow-governance
```

OwnHow uses OpenClaw's eligible Skill report and loaded Plugin registry, retaining bundled Skills even when they have no separately discoverable path. Use `--runtime openclaw` for OpenClaw-only analysis.

## Update CLI and Skill together

The source version adds `ownhow upgrade --check --json`, `--apply`, and opt-in
patch updates with `--enable-auto` / `--auto`. Releases can notify an Agent
gateway through an optional webhook; Agents validate the official release
before updating. See [Agent updates](docs/agent-updates.md) for enrollment,
standalone versus Plugin handling, push delivery, and failure recovery.
The task-boundary check follows a gstack-like flow: enrolled Agents run
`ownhow upgrade --auto --json`, while unenrolled Agents get a read-only result
that can be reviewed before applying. A declined version can be snoozed for
24 hours, 48 hours, and then one week on repeated deferrals.

## Optional usage telemetry

OwnHow works without a server. Telemetry is **off by default** and local
governance, resolution, receipts, and Personal Methods do not depend on it.
Enable it only when you want to measure adoption or diagnose aggregate usage:

```bash
# Keep an aggregate event ledger on this machine (recommended starting point)
ownhow telemetry enable --mode local
ownhow telemetry status
ownhow telemetry export

# Explicitly opt in to a server; the endpoint must use HTTPS
ownhow telemetry enable --mode remote --endpoint https://telemetry.example.invalid/events
ownhow telemetry send

# Stop collecting; existing local events remain until you remove them
ownhow telemetry disable
ownhow telemetry purge
```

The local ledger is stored under `<state>/telemetry/` (`~/.ownhow/telemetry/`
by default). Remote mode sends only bucketed, aggregate counters and outcome
categories: runtime/scope, command result, cache mode, latency, candidate and
Skill counts, finding counts, whether a Personal Method was used, whether a
correction was provided, and the verification category. It does not send task
text, prompts, receipts, evidence, corrections, Skill or Plugin content,
Personal Methods, filesystem paths, machine names, or user identity. The
server receives statistics only: it cannot install, update, enable, disable,
or execute anything on an Agent. Review the endpoint's retention and access
policy before enabling remote mode. See [docs/telemetry.md](docs/telemetry.md)
for the request contract and [SECURITY.md](SECURITY.md) for the privacy and
trust-boundary details.

## Run from source

```bash
git clone https://github.com/x2v-co/ownhow.git
cd ownhow
npm link

ownhow analyze --runtime codex
ownhow resolve "review a merge request, fix findings, and verify the result" --runtime hermes
ownhow analyze --runtime claude
ownhow analyze --runtime pi
ownhow analyze --runtime opencode
ownhow analyze --runtime openclaw
ownhow doctor --runtime skywork
```

`analyze` and `resolve` scan the live installation without writing inventory, Receipt, or Method state. If telemetry was explicitly enabled, they append one aggregate telemetry event. Run `ownhow scan --runtime <runtime>` when you explicitly want to save a snapshot, pass `--cached` to always use that snapshot, or pass `--fast` to use a matching snapshot when it is no older than five minutes and fall back to a live scan. Set `OWNHOW_FAST_TTL_MS` to change the fast-snapshot age limit. State is stored in `~/.ownhow` by default. Use `--state PATH` for an isolated experiment, `--root PATH` to scan an explicit source, and `--runtime codex|hermes|claude|pi|opencode|openclaw|skywork|all` to select the runtime.

Inventory state is explicit: `discovered`, `installed`, `enabled`, and `sessionVisible` are tracked separately. `actualUsed` is separate execution evidence: it remains unknown unless the host or Agent reports that a Skill was used. Runtime adapters use their authoritative active/eligible reports when available; otherwise OwnHow marks installation and visibility as unknown and labels the scope as `runtime-roots`. Recursive fallback scanning excludes `.review/`, `.smoke/`, temporary worktrees, build output, and common caches. Conflict analysis and task resolution strictly use the `session-visible` scope when an authoritative report exists; fallback results are clearly labeled candidates with unknown activation state and never include excluded temporary checkouts.

## Runtime scope and diagnosis

Select `--runtime` explicitly or set `OWNHOW_RUNTIME`. Without either, only an explicit `--root` scan is allowed; its runtime scope is `all` and component runtimes are inferred from known paths. Use `--runtime all` for cross-runtime comparison. A cached inventory must match the requested runtime; old snapshots without runtime metadata must be rescanned. `--cached` cannot be combined with `--root` or `--session-manifest`.

Skywork directory discovery checks `~/.skywork/plugins`, `~/.skywork/skills`, and project `.skywork/skills`. These are candidates with unknown activation state. Use `--root` for another installation path. When a host provides the exact current-session list, pass `--session-manifest PATH` with this JSON shape. `actualUsedSkillNames` is optional and must be exhaustive for the observed task/session; omit it when the host cannot prove usage:

```json
{"schemaVersion":"1","runtime":"skywork","skills":[{"file":"/absolute/path/to/SKILL.md","name":"ownhow-governance"}],"activeSkillNames":["ownhow-governance"],"actualUsedSkillNames":["ownhow-governance"]}
```

The manifest must match one selected runtime. OwnHow trusts this host report; it does not independently prove visibility. `ownhow doctor --runtime skywork` reports the CLI path/version, discovery scope, OwnHow components, and metadata parse errors without saving state.

Cross-runtime copies are informational. Same-session name and declared write collisions are reported separately from semantic overlap, which is a routing hint rather than proof of a behavioral conflict. Text-only risk hints do not become approval requirements. Resolve exposes per-field scores and exclusion reasons, and only adds an augment when that Skill explicitly declares `augments: [primary-skill-name]` in the same runtime.

## Slim a Skill library

Use `ownhow slim --runtime <runtime>` to review unused, overlapping, and oversized
Skills with a suggested smaller set and per-Skill reasons. Unknown usage stays
unknown. Create an explicit selection with `ownhow slim allow <name...> --runtime
<runtime>`; `resolve` then considers only those names. `slim deny` removes names
and `slim list` shows the saved lists.

`ownhow slim apply --runtime <runtime>` previews runtime changes. Add `--write`
to move supported private standalone Skills into a disabled directory;
`slim restore --runtime <runtime> --write` brings them back. Files are never
deleted. Unsupported installations get the allowlist and manual instructions.
See [slimming and selection](docs/slimming.md) for evidence rules, defaults,
runtime support, and recovery.

## Mandatory artifact checks

Every live scan inspects the files of discovered Skills, including caches, temporary directories and build outputs that are excluded from Skill discovery. `analyze` reports these two required checks:

| Check ID | Mandatory check item |
|---|---|
| `python_bytecode` | Stale/mismatched Python bytecode: orphan `.pyc` files, including `__pycache__`, and embedded source mtime/size or PEP 552 hash mismatches. Bytecode may carry behavior that differs from reviewed source. See [PyCache Trap](https://arxiv.org/abs/2610.10612). |
| `cross_session_residue` | Cross-session file residue: temp files, caches, outputs and state in the Skill, declared writes outside it, and existing shared/workspace/home or writable state declared as input. These artifacts can leak data or poison later sessions. See [persistent-artifact attacks](https://arxiv.org/abs/2610.13227). |
| `self_log_tampering` | Writes or commands that modify logs, audit trails, receipts, transcripts or history can hide actions from oversight. |
| `external_network_access` | Network commands/APIs, declared network tools/effects and remote MCP URLs can enable exfiltration or unauthorized access. |
| `cross_agent_communication` | Agent tools/CLIs, A2A and writes into other agents' directories can enable collusion. These three permission checks reference [CASP](https://casp.ac/reports/intelligence-explosion). |


Use `ownhow analyze --runtime <runtime> --json` for `requiredChecks` coverage, per-Skill `results` with limitations, and findings with file paths and reasons. Full per-Skill evidence lives in inventory `auditChecks`. Old snapshots and unavailable evidence remain `unknown`; use a live scan for an audit. Matching bytecode headers do not establish body equivalence, and residue candidates do not establish session ownership. The checks never execute scanned code or remove files. Permission risks default to `warn`, without changing approvals or exit codes. Use `analyze --permission-checks=off|warn|block`, per-check `--permission-check ID=MODE`, or `OWNHOW_PERMISSION_CHECKS`; only findings in `block` mode make `analyze` exit 1. Exact Skill IDs can be allowlisted with `--permission-allow-skill ID`. See [audit check definitions and limits](docs/audit-checks.md).

## Personal Method loop

Record a real outcome and the correction you had to repeat:

```bash
ownhow record "review a merge request, fix findings, and verify the result" \
  --outcome failure \
  --correction "Run focused tests before asking for another review" \
  --summary "The requested fixes were made, but verification was missing" \
  --blocker "Focused tests were not run" \
  --confidence low \
  --verified-by user \
  --runtime codex

ownhow propose
```

Review the proposal under `~/.ownhow/proposals/`. Applying it is always explicit:

```bash
ownhow apply proposal-123
ownhow resolve "review a merge request, fix findings, and verify the result" --runtime codex
```

The second resolve includes the Personal Method correction. The original Plugin and Skill remain unchanged.

Each applied correction creates a version and retains history. `ownhow methods` lists current methods. After reviewing the older correction, `ownhow rollback <method-id> --version 0.1.0` restores it as a new revision; it does not erase intervening versions.

For execution evidence, save the plan before performing the task and pass that exact file to `record`:

```bash
ownhow resolve "verify login behavior" --runtime codex --save-plan ./login-plan.json
# Perform the task, then record its observed outcome and evidence.
ownhow record "verify login behavior" --runtime codex --plan ./login-plan.json \
  --outcome success --sample-kind business \
  --summary "Login behavior verified" --evidence "Observed expected login result" \
  --verified-by agent
```

When the Agent can report Skill usage directly, add a structured governance
result rather than relying on prose:

```bash
ownhow record "verify login behavior" --runtime codex --plan ./login-plan.json \
  --outcome success --governance '{"discovered":true,"matched":true,"loaded":true,"actualUsed":true,"verified":true}'
```

Record `--method-use loaded` or `followed` only when the saved plan contains a Personal Method and the assertion is true. Otherwise it remains `unknown`. Without `--plan`, the receipt explicitly records retrospective selection. Missing plans, changed digests, and mismatched tasks/runtimes are rejected. The digest checks consistency, not whether execution actually happened. `--sample-kind business|demo|workflow-test|unknown` separates business evidence from workflow tests.

Plan attribution and sample kind are currently local receipt fields. Governance evidence is separate from installation discovery: `discovered`, `matched`, `loaded`, `actualUsed`, `followed`, `reused`, and `verified` are typed boolean/null fields. Receipt Bundle v2 may carry these fields; v1 remains minimal. Unknown values stay `null` rather than being inferred from a directory scan.


## Recover receipts from remote Agents

When a remote Agent cannot be reached through SSH, use the Agent-carried Receipt Bundle protocol. On the remote machine, record the actual work outcome with concise evidence and export a copyable capsule:

```bash
ownhow record "research customer onboarding" \
  --outcome failure \
  --correction "Cite the customer's observed workflow" \
  --summary "The research was delivered without traceable interview evidence" \
  --evidence "User review rejected unsupported workflow claims" \
  --blocker "No approved source citations" \
  --confidence low \
  --verified-by user \
  --runtime hermes
ownhow export --receipt latest --agent-id customer-research-a
```

The Agent should return the single `ownhow:receipt-bundle:v2:...` line through the existing chat. v2 adds a summary, evidence, artifacts, blockers, confidence, verifier, and optional structured governance evidence including `actualUsed`. The capsule still omits raw conversation, Skill bodies, inventories, full local paths, and traces. OwnHow redacts common path and credential patterns, but the remote user or Agent must review every exported text field before sharing. Use `--protocol v1` only when the receiving installation has not upgraded to v0.6.0.

`export --receipt latest` selects the latest locally recorded Receipt by default and will not silently relabel an imported remote Receipt. Supplying `--runtime` also limits latest selection to that runtime and rejects an explicitly selected Receipt with a mismatched runtime. Re-exporting an imported Receipt requires both `--source imported` and `--reexport-imported` so provenance changes are deliberate.

On the trusted primary machine, pass long capsules over stdin when possible:

```bash
ownhow import -
ownhow inbox
ownhow inbox show import-123
ownhow inbox accept import-123
ownhow propose --receipt receipt-imported-123
```

Import only creates a pending Inbox entry under `~/.ownhow/inbox/`. It cannot be used by `propose` until `inbox accept` explicitly appends a normalized local Receipt. Use `ownhow inbox reject <import-id>` to retain an audit record without accepting it.

The SHA-256 digest detects transport corruption; it does not authenticate the remote Agent. Treat the Agent, chat, capsule, task, and correction as untrusted data. OwnHow validates a strict versioned schema and never executes imported text. The protocol is local-first and requires no OwnHow account or cloud service.

See [Receipt Bundle Protocol v2](docs/receipt-bundle-v2.md) for the evidence-rich envelope and [Receipt Bundle Protocol v1](docs/receipt-bundle-v1.md) for the compatibility format.

## Commands

| Command | Purpose |
|---|---|
| `scan` | Save an inventory with discovery and visibility states; leave source methods unchanged |
| `analyze` | Detect duplicate names, semantic overlap, write collisions, missing metadata, risk surfaces, bytecode mismatches, and session residue |
| `resolve <task>` | Produce a deterministic task plan with selection reasons and approval risks |
| `slim [allow\|deny\|list\|apply\|restore]` | Review library size, select Skill names per runtime, and preview or explicitly apply reversible visibility changes |
| `record <task>` | Save a local receipt with outcome, verification evidence, and optional correction |
| `export` | Export an evidence-rich Receipt Bundle capsule for Agent-mediated recovery |
| `import` | Validate a capsule and place it in the pending Inbox |
| `inbox` | List, review, explicitly accept, or reject remote receipts (`inbox list` is also accepted) |
| `propose` | Create a reviewable Personal Method proposal from a corrected receipt |
| `apply <id>` | Explicitly apply a proposal as a local overlay |
| `status` | Show local inventory, receipt, and method counts |
| `upgrade` | Check/apply releases, enroll patch updates, or consume a version notice |
| `doctor` | Report paths, versions, scope, and metadata errors |
| `methods` | List current Personal Methods and versions |
| `rollback <method-id> --version VERSION` | Restore an older correction as a new revision |
| `telemetry status|enable|disable|export|purge|send` | Inspect or explicitly manage aggregate local/remote usage telemetry (off by default) |

Add `--json` to any command for structured output.

## Verify

```bash
npm test
npm run verify
```

After editing the Plugin workflow, run `node scripts/sync-skills.js` to regenerate the standalone Skill. Verification checks that both workflows stay aligned. This release publishes the CLI, standalone Skill, and update bundle as v0.9.0.

## Runtime support and MVP boundary

- Runtime-aware Codex, Hermes, Claude Code, Pi, OpenCode, and OpenClaw sources; Skywork directory discovery and host session manifests
- Deterministic local analysis; no LLM resolver
- Local JSON/JSONL state with evidence-rich Receipt details
- Personal Method overlays do not rewrite upstream packages
- No required cloud account, hosted registry, team control plane, or automatic evolution; optional telemetry is aggregate-only and opt-in
- Hermes' autonomous skill editing is not automatically trusted or converted into an OwnHow Personal Method; it must enter through Receipt → Proposal → explicit approval → Overlay.

## Privacy and security

OwnHow state can reveal private workflows and local filesystem paths. Do not commit or upload `~/.ownhow`, real inventories, receipts, corrections, proposals, or Personal Methods. Telemetry is disabled unless explicitly enabled and remote mode is an additional explicit opt-in; it excludes task text, receipts, Skill content, paths, and Personal Methods. See [SECURITY.md](SECURITY.md) for the disclosure and test-data policy.

## Contributing

OwnHow is in an evidence-gathering MVP phase. Reproducible selection failures, synthetic fixtures, and focused resolver or safety fixes are more useful than broad platform features. See [CONTRIBUTING.md](CONTRIBUTING.md).
