# Security Policy

## Reporting

Report security issues privately through GitHub Security Advisories for `x2v-co/ownhow`. Do not open a public issue for a vulnerability or attach private method data to a report.

## Sensitive Local Data

OwnHow stores local state under `~/.ownhow` by default. Inventories, receipts, corrections, proposals, and Personal Methods may reveal private workflows, filesystem paths, installed capabilities, or organizational practices.

Do not commit or upload:

- `~/.ownhow` or another OwnHow state directory;
- real Plugin or Skill inventories;
- receipts, corrections, proposals, or Personal Methods;
- credentials, tokens, private Skill content, or execution traces.

Use synthetic fixtures and an isolated `--state` directory when reproducing an issue. Review all generated output before sharing it.

## Optional Telemetry and Privacy

Telemetry is disabled by default. OwnHow remains fully usable without a
server, and enabling local telemetry is an explicit user choice:

```bash
ownhow telemetry enable --mode local
ownhow telemetry status
```

A remote endpoint requires a separate explicit opt-in and an HTTPS URL:

```bash
ownhow telemetry enable --mode remote --endpoint https://telemetry.example.invalid/events
ownhow telemetry send
```

Local telemetry is an aggregate event ledger under `<state>/telemetry/`.
Events contain only bounded categories and buckets: runtime and discovery
scope, command result, cache mode, latency, candidate/Skill/finding counts,
Personal Method use, correction presence, and verification category. The
schema intentionally excludes task text and prompts, receipts and evidence,
corrections, Skill or Plugin bodies, Personal Methods, filesystem paths,
machine names, and user identity. A pseudonymous agent identifier may be
used to prevent duplicate counting; it is not an identity guarantee.

Remote telemetry is statistics collection only. The endpoint cannot issue
commands, install or update OwnHow, change an Agent's Skills, read local
receipts, or control a session. Server operators should document retention,
access, and deletion policies; users should review those policies before
enabling remote mode. `telemetry disable` stops new events but preserves the
local ledger until `telemetry purge` is explicitly run. Failed telemetry must
not block the main OwnHow command.

## Trust Boundary

OwnHow treats scanned Plugin and Skill content as untrusted data. Reports derived from static text are signals, not proof that a component performed an action. The CLI does not install, disable, delete, or modify scanned components.

Live scans run the mandatory `python_bytecode` and `cross_session_residue` checks. Artifact inspection includes cache, temporary and output files inside each discovered Skill. External declared read/write targets are inspected for existence and canonical location without reading their contents or recursively searching the user's home/workspace. Source-hash verification runs a fixed helper with `python3 -I -S`; it treats source bytes as data and never imports, unmarshals or executes scanned source/bytecode. As with runtime adapter commands, the local executable found through `PATH` must be trusted.

Bytecode header checks cannot detect a substituted body whose metadata was forged to match source. Residue findings identify persistence surfaces, with session ownership left unknown. Undeclared/dynamic effects need script review and session provenance evidence. Traversal limits, symlinks, missing sources from runtime reports and unavailable hash verification remain explicit limitations, never a clean audit. See [audit check definitions](docs/audit-checks.md) and the motivating research on [bytecode substitutions](https://arxiv.org/abs/2610.10612) and [cross-session artifacts](https://arxiv.org/abs/2610.13227).

Telemetry endpoints are outside OwnHow's local trust boundary. OwnHow accepts
only HTTPS endpoints without embedded credentials or URL fragments and sends
the bounded aggregate event schema. It does not treat a server response as an
instruction and has no remote-control channel.

## Remote Receipt Bundles

The `ownhow:receipt-bundle:v1:` and `ownhow:receipt-bundle:v2:` capsules are untrusted copy-and-paste transports for remote Agent task metadata. Their SHA-256 digest detects payload changes after export, but does not authenticate the Agent, machine, user, or conversation. v2 additionally carries a summary, evidence, artifacts, blockers, confidence, a self-asserted verifier label, and optional typed governance evidence.

- Import writes only to the pending Inbox; explicit `inbox accept` is required before a Receipt enters the evolution flow.
- Imported text is validated as data and is never executed as a command or Agent instruction.
- The v1 schema rejects unknown fields, unsupported versions, oversized values, malformed timestamps, terminal control characters, and digest mismatches.
- Export omits raw conversations, inventories, Skill bodies, traces, and local component identifiers. It redacts common path and credential patterns across task details, but cannot guarantee removal of all confidential data.
- Export selects local Receipts by default. Re-exporting an imported Receipt requires explicit source selection and an explicit re-export flag to reduce accidental source relabeling.
- Review the source label, task, correction, redaction notices, and customer confidentiality before accepting. A source `agentId` is a self-asserted label, not verified identity.
- Governance evidence (`discovered`, `matched`, `loaded`, `actualUsed`, `followed`, `reused`, and `verified`) describes what the sending Agent reports; it does not prove that a Skill ran.
- Duplicate bundle, digest, and source Receipt IDs are imported idempotently. Rejected imports remain as local audit records rather than being deleted.

## Inventory Scope

A filesystem candidate is not proof that a Skill is installed, enabled, or callable in the current Agent session. OwnHow records those lifecycle states independently. When a runtime does not expose an authoritative active/eligible report, installation and session visibility remain unknown; reports must not present candidate discovery as active capability. Recursive fallback scans exclude temporary review/smoke directories, worktrees, build output, and common caches.


The mandatory permission checks `self_log_tampering`, `external_network_access` and `cross_agent_communication` statically inspect Skill frontmatter/body, scripts and manifests, plus known enclosing Plugin manifests. They never execute scanned content, contact detected hosts or launch detected agent commands. Log tampering can hide actions from oversight; external network access enables exfiltration or unauthorized access; cross-agent communication can enable collusion. They reference [CASP's intelligence-explosion report](https://casp.ac/reports/intelligence-explosion). Its roughly 1,200-agent collusion example is a second-hand account as reported in the paper, not independently verified here.

Permission checks default to `warn` and leave approval policy and exit codes unchanged. `analyze` supports `off` (status `skipped`), `warn`, and `block` per check; only a finding in `block` mode produces exit code 1. CLI flags override `OWNHOW_PERMISSION_CHECKS`; an explicit exact-Skill-ID allowlist skips only permission findings. This policy is a static review aid, not a runtime sandbox. Permission text reads are capped at 1 MiB per file, binaries are skipped, and traversal/read limitations remain visible. Obfuscation, dynamic URLs, computed paths and lexical false positives require human review; prose indicators receive lower risk than executable content or declared tools. See [Skill permission risks](docs/audit-checks.md#skill-permission-risks) for exact configuration and scope.
