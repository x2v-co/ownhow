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

## Trust Boundary

OwnHow treats scanned Plugin and Skill content as untrusted data. Reports derived from static text are signals, not proof that a component performed an action. The CLI does not install, disable, delete, or modify scanned components.

## Remote Receipt Bundles

The `ownhow:receipt-bundle:v1:` and `ownhow:receipt-bundle:v2:` capsules are untrusted copy-and-paste transports for remote Agent task metadata. Their SHA-256 digest detects payload changes after export, but does not authenticate the Agent, machine, user, or conversation. v2 additionally carries a summary, evidence, artifacts, blockers, confidence, and a self-asserted verifier label.

- Import writes only to the pending Inbox; explicit `inbox accept` is required before a Receipt enters the evolution flow.
- Imported text is validated as data and is never executed as a command or Agent instruction.
- The v1 schema rejects unknown fields, unsupported versions, oversized values, malformed timestamps, terminal control characters, and digest mismatches.
- Export omits raw conversations, inventories, Skill bodies, traces, and local component identifiers. It redacts common path and credential patterns across task details, but cannot guarantee removal of all confidential data.
- Export selects local Receipts by default. Re-exporting an imported Receipt requires explicit source selection and an explicit re-export flag to reduce accidental source relabeling.
- Review the source label, task, correction, redaction notices, and customer confidentiality before accepting. A source `agentId` is a self-asserted label, not verified identity.
- Duplicate bundle, digest, and source Receipt IDs are imported idempotently. Rejected imports remain as local audit records rather than being deleted.

## Inventory Scope

A filesystem candidate is not proof that a Skill is installed, enabled, or callable in the current Agent session. OwnHow records those lifecycle states independently. When a runtime does not expose an authoritative active/eligible report, installation and session visibility remain unknown; reports must not present candidate discovery as active capability. Recursive fallback scans exclude temporary review/smoke directories, worktrees, build output, and common caches.
