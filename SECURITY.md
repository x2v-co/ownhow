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

The `ownhow:receipt-bundle:v1:` capsule is an untrusted copy-and-paste transport for remote Agent task metadata. Its SHA-256 digest detects payload changes after export, but does not authenticate the Agent, machine, user, or conversation.

- Import writes only to the pending Inbox; explicit `inbox accept` is required before a Receipt enters the evolution flow.
- Imported text is validated as data and is never executed as a command or Agent instruction.
- The v1 schema rejects unknown fields, unsupported versions, oversized values, malformed timestamps, terminal control characters, and digest mismatches.
- Export omits raw conversations, inventories, Skill bodies, traces, and local component identifiers. It redacts common path and credential patterns, but cannot guarantee removal of all confidential data.
- Review the source label, task, correction, redaction notices, and customer confidentiality before accepting. A source `agentId` is a self-asserted label, not verified identity.
- Duplicate bundle, digest, and source Receipt IDs are imported idempotently. Rejected imports remain as local audit records rather than being deleted.
